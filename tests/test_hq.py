"""Tests run without Ollama, using a scripted fake model.  python -m unittest -v"""
import json
import time
import unittest

from hq.db import DB
from hq.guard import redact
from hq.llm import LLMError
from hq.memory import Memory
from hq.orchestrator import Orchestrator
from hq.router import keyword_route


class FakeLLM:
    def __init__(self):
        self.calls = []
        self.fail_next = 0

    def status(self):
        return {"ollama": "up", "models": []}

    def chat(self, model, messages, json_mode=False, temperature=0.4):
        return json.dumps(self.chat_json(model, messages))

    def chat_json(self, model, messages):
        system, user = messages[0]["content"], messages[-1]["content"]
        self.calls.append((system[:40], user[:80]))
        if self.fail_next:
            self.fail_next -= 1
            raise LLMError("simulated outage")
        if system.startswith("You route tasks"):
            if "weather app" in user:
                return {"agent": "jarvis", "reason": "multi-part"}
            return {"agent": "coder", "reason": "code"}
        if system.startswith("Extract durable facts"):
            return {"memories": [{"text": "User runs qwen3:14b on an RX 9060 XT", "importance": 0.8, "shared": True}]}
        if "You are Jarvis" in system:
            if "teammates finished" in user:
                return {"reply": "Combined: plan + code + review"}
            assert "coder: Forge" in system, "team roster must be in the lead's prompt"
            return {"reply": "Splitting this up.", "delegate": [
                {"agent": "researcher", "task": "Pick a free weather API"},
                {"agent": "coder", "task": "Write the Python app"},
                {"agent": "nobody", "task": "invalid agent is ignored"},
            ]}
        if "You are Forge" in system:
            return {"reply": "print('hi')  # api_key=supersecretvalue123"}
        if "You are Atlas" in system:
            return {"reply": "Use Open-Meteo, no key needed."}
        return {"reply": "ok"}


def drain(orch, limit=20):
    for _ in range(limit):
        task = orch.db.next_queued()
        if not task:
            return
        orch.run_once(task)


class OrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.llm = FakeLLM()
        self.orch = Orchestrator(DB(":memory:"), self.llm)

    def test_delegation_and_synthesis(self):
        tid = self.orch.submit("make a weather app in python")
        drain(self.orch)
        task = self.orch.db.task(tid)
        self.assertEqual(task["status"], "complete")
        self.assertEqual(task["agent"], "jarvis")
        self.assertEqual(task["result"], "Combined: plan + code + review")
        kids = self.orch.db.children(tid)
        self.assertEqual([k["agent"] for k in kids], ["researcher", "coder"])
        self.assertTrue(all(k["status"] == "complete" for k in kids))
        events = [h["event"] for h in self.orch.db.hive(100)]
        for e in ("routed", "delegated", "waiting", "complete"):
            self.assertIn(e, events)

    def test_child_output_is_redacted(self):
        tid = self.orch.submit("write code", agent="coder")
        drain(self.orch)
        result = self.orch.db.task(tid)["result"]
        self.assertNotIn("supersecretvalue123", result)
        self.assertIn("[REDACTED]", result)

    def test_manual_agent_choice_skips_router(self):
        self.orch.submit("anything", agent="researcher")
        drain(self.orch)
        self.assertFalse(any(c[0].startswith("You route tasks") for c in self.llm.calls))

    def test_retry_then_fail_is_recorded(self):
        self.llm.fail_next = 10
        orch = self.orch
        from unittest import mock
        tid = orch.submit("x", agent="coder")
        with mock.patch("hq.orchestrator.time.sleep"):  # don't wait between retries
            drain(orch)
        task = orch.db.task(tid)
        self.assertEqual(task["status"], "failed")
        self.assertIn("simulated outage", task["error"])
        self.assertEqual(task["attempts"], 2)

    def test_cancel_queued(self):
        tid = self.orch.submit("later")
        self.assertTrue(self.orch.cancel(tid))
        self.assertIsNone(self.orch.db.next_queued())

    def test_notifier_called_for_top_level_only(self):
        seen = []
        self.orch.notifiers.append(lambda t: seen.append(t["id"]))
        tid = self.orch.submit("make a weather app in python")
        drain(self.orch)
        self.assertEqual(seen, [tid])


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.db = DB(":memory:")
        self.mem = Memory(self.db, FakeLLM())

    def test_extract_and_recall(self):
        self.mem.extract("jarvis", "what gpu do I have", "RX 9060 XT")
        self.assertIn("User runs qwen3:14b on an RX 9060 XT", self.mem.recall("which gpu and qwen3 model", "coder"))

    def test_duplicates_merge_on_add(self):
        a = self.mem.add("The user prefers Python for scripts")
        b = self.mem.add("The user prefers Python for scripts.")
        self.assertEqual(a, b)

    def test_decay_forgets_unpinned_but_keeps_pinned(self):
        self.mem.add("Old trivia about a cafe menu", importance=0.3)
        self.mem.add("Pinned: home lab is Proxmox at 192.168.4.90", pinned=True, importance=0.3)
        stats = self.mem.maintain(now=time.time() + 60 * 86400)
        texts = [m["text"] for m in self.mem.list()]
        self.assertEqual(stats["forgotten"], 1)
        self.assertEqual(texts, ["Pinned: home lab is Proxmox at 192.168.4.90"])


class GuardAndRouterTests(unittest.TestCase):
    def test_redacts_common_secrets(self):
        text = "key sk-ant-abcdefghijklmnopqrstuvwxyz123 and ghp_" + "a" * 36 + " and AKIAABCDEFGHIJKLMNOP"
        clean, found = redact(text)
        self.assertNotIn("sk-ant-abc", clean)
        self.assertNotIn("ghp_aaaa", clean)
        self.assertNotIn("AKIAABCD", clean)
        self.assertEqual(set(found), {"anthropic key", "github token", "aws key"})

    def test_clean_text_unchanged(self):
        self.assertEqual(redact("hello world")[0], "hello world")

    def test_keyword_fallback(self):
        self.assertEqual(keyword_route("fix this python bug"), "coder")
        self.assertEqual(keyword_route("audit my firewall"), "security")
        self.assertEqual(keyword_route("hi there"), "jarvis")


class TelegramTests(unittest.TestCase):
    def setUp(self):
        from hq.telegram import TelegramBot
        self.orch = Orchestrator(DB(":memory:"), FakeLLM())
        self.bot = TelegramBot(self.orch, token="x", allowed={"42"})
        self.sent = []
        self.bot.send = lambda chat, text: self.sent.append((chat, text))

    def test_stranger_is_rejected_and_told_their_id(self):
        self.bot.handle({"chat": {"id": 7}, "text": "run something"})
        self.assertIsNone(self.orch.db.next_queued())
        self.assertIn("7", self.sent[0][1])

    def test_allowed_chat_queues_and_gets_reply(self):
        self.bot.handle({"chat": {"id": 42}, "text": "/coder write code"})
        task = self.orch.db.next_queued()
        self.assertEqual((task["requested_agent"], task["prompt"]), ("coder", "write code"))
        drain(self.orch)
        self.assertTrue(self.sent[-1][1].startswith("print('hi')"))


if __name__ == "__main__":
    unittest.main()
