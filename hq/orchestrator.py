"""The sequential task queue: routing, delegation, synthesis and memory.

One worker runs one task at a time, so a single GPU never gets two jobs at once.
Every failure is recorded on the task and in the hive log; nothing fails silently.
"""
import json
import queue
import threading
import time
import urllib.request

from . import agents as agents_mod
from .agents import AGENTS, build_messages, save_obsidian_note
from .config import Config
from .guard import redact
from .llm import LLMError
from .memory import Memory
from .router import route

TERMINAL = {"complete", "failed", "cancelled"}
MAX_ATTEMPTS = 2


class EventBus:
    def __init__(self):
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=500)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def publish(self, event: dict) -> None:
        event.setdefault("ts", time.time())
        with self._lock:
            for q in list(self._subs):
                try:
                    q.put_nowait(event)
                except queue.Full:
                    pass


class Orchestrator:
    def __init__(self, db, llm, bus: EventBus | None = None):
        self.db = db
        self.llm = llm
        self.bus = bus or EventBus()
        self.memory = Memory(db, llm)
        self.notifiers: list = []  # callables(task) for finished top-level tasks
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._memory_jobs: queue.Queue = queue.Queue()
        self.current_task_id: int | None = None

    # ---- public API --------------------------------------------------------
    def submit(self, prompt: str, agent: str = "auto", source: str = "dashboard",
               chat_id: str | None = None) -> int:
        agent = agent if agent in AGENTS else "auto"
        task_id = self.db.add_task(prompt, agent, source, chat_id)
        self._emit(task_id, "queued", f"{source}: {prompt[:120]}")
        self._wake.set()
        return task_id

    def cancel(self, task_id: int) -> bool:
        task = self.db.task(task_id)
        if not task or task["status"] in TERMINAL:
            return False
        self.db.update_task(task_id, status="cancelled")
        for child in self.db.children(task_id):
            if child["status"] not in TERMINAL:
                self.db.update_task(child["id"], status="cancelled")
        self._emit(task_id, "cancelled", "cancelled by user")
        return True

    def start(self) -> None:
        threading.Thread(target=self._worker, name="hq-worker", daemon=True).start()
        threading.Thread(target=self._memory_worker, name="hq-memory", daemon=True).start()
        threading.Thread(target=self._maintenance, name="hq-maintenance", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    # ---- internals ---------------------------------------------------------
    def _emit(self, task_id: int | None, status: str, summary: str, agent: str = "hq") -> None:
        self.db.log(agent, status, summary, task_id)
        self.bus.publish({"type": "task", "task_id": task_id, "status": status,
                          "agent": agent, "summary": summary[:300]})

    def _worker(self) -> None:
        while not self._stop.is_set():
            task = self.db.next_queued()
            if not task:
                self._wake.wait(timeout=2)
                self._wake.clear()
                continue
            self.run_once(task)

    def run_once(self, task: dict) -> None:
        """Run one queued task. Public so tests can drive the queue step by step."""
        task_id = task["id"]
        self.current_task_id = task_id
        self.db.update_task(task_id, status="running", attempts=task["attempts"] + 1)
        try:
            self._run(task)
        except Exception as exc:  # noqa: BLE001 - record every failure
            fresh = self.db.task(task_id)
            if fresh and fresh["status"] == "cancelled":
                pass
            elif task["attempts"] + 1 < MAX_ATTEMPTS and isinstance(exc, LLMError):
                self.db.update_task(task_id, status="queued", error=str(exc))
                self._emit(task_id, "retrying", str(exc), task.get("agent") or "hq")
                time.sleep(3)
            else:
                self.db.update_task(task_id, status="failed", error=str(exc))
                self._emit(task_id, "failed", str(exc), task.get("agent") or "hq")
                self._finish(task_id)
        finally:
            self.current_task_id = None

    def _run(self, task: dict) -> None:
        task_id = task["id"]
        agent_key = task["agent"]
        if not agent_key:
            if task["requested_agent"] != "auto":
                agent_key, reason = task["requested_agent"], "chosen by user"
            else:
                agent_key, reason = route(self.llm, task["prompt"])
            self.db.update_task(task_id, agent=agent_key)
            self._emit(task_id, "routed", f"→ {agent_key} ({reason})", agent_key)
        agent = AGENTS.get(agent_key) or AGENTS["jarvis"]
        self._emit(task_id, "thinking", task["prompt"][:120], agent.key)

        if agent.key == "operator":
            answer = self._run_agenticseek(task["prompt"])
            self._complete(task, agent.key, answer)
            return

        children = self.db.children(task_id)
        synthesis = bool(children) and all(c["status"] in TERMINAL for c in children)
        allow_delegation = (agent.can_delegate and not synthesis
                            and task["depth"] < Config.max_delegation_depth)

        history = []
        if task["depth"] == 0 and task["chat_id"]:
            history = self.db.all(
                "SELECT prompt, result FROM tasks WHERE chat_id=? AND depth=0 AND status='complete'"
                " AND id<? ORDER BY id DESC LIMIT 4", (task["chat_id"], task_id))[::-1]

        messages = build_messages(
            agent, task,
            hive=self.db.hive(25),
            memories=self.memory.recall(task["prompt"], agent.key),
            history=history,
            child_results=children if synthesis else None,
            allow_delegation=allow_delegation,
        )
        data = self.llm.chat_json(Config.model, messages)
        if self.db.task(task_id)["status"] == "cancelled":
            return
        reply = str(data.get("reply") or "").strip()
        if not reply and not data.get("delegate"):
            raise LLMError("model returned an empty or non-JSON reply")

        if agent.key == "vault" and isinstance(data.get("note"), dict):
            note = data["note"]
            path = save_obsidian_note(str(note.get("title", "note")), str(note.get("content", "")))
            if path:
                reply += f"\n\n(Saved note: {path})"

        delegations = data.get("delegate") if allow_delegation else None
        valid = []
        if isinstance(delegations, list):
            for d in delegations[:5]:
                if isinstance(d, dict) and d.get("agent") in AGENTS and d.get("agent") != agent.key and d.get("task"):
                    valid.append(d)
        if valid:
            self.db.update_task(task_id, status="waiting", result=reply)
            for d in valid:
                child_id = self.db.add_task(str(d["task"]), d["agent"], "delegation",
                                            task["chat_id"], parent_id=task_id, depth=task["depth"] + 1)
                self.db.update_task(child_id, agent=d["agent"])
                self._emit(child_id, "delegated", f"{agent.key} → {d['agent']}: {str(d['task'])[:120]}", agent.key)
            self._emit(task_id, "waiting", f"waiting on {len(valid)} teammate(s)", agent.key)
            self._wake.set()
            return

        self._complete(task, agent.key, reply or "(no answer)")

    def _complete(self, task: dict, agent_key: str, answer: str) -> None:
        answer, redacted = redact(answer)
        if redacted:
            self._emit(task["id"], "guard", "redacted: " + ", ".join(redacted), "guard")
        self.db.update_task(task["id"], status="complete", result=answer, error=None)
        self._emit(task["id"], "complete", answer[:200], agent_key)
        if task["depth"] == 0:
            self._memory_jobs.put((agent_key, task["prompt"], answer))
        self._finish(task["id"])

    def _finish(self, task_id: int) -> None:
        task = self.db.task(task_id)
        if task["parent_id"]:
            parent = self.db.task(task["parent_id"])
            if parent and parent["status"] == "waiting":
                if all(c["status"] in TERMINAL for c in self.db.children(parent["id"])):
                    self.db.update_task(parent["id"], status="queued")
                    self._emit(parent["id"], "queued", "teammates done, combining results", parent["agent"] or "hq")
                    self._wake.set()
        elif task["status"] in TERMINAL:
            for notify in self.notifiers:
                try:
                    notify(task)
                except Exception as exc:  # noqa: BLE001
                    self._emit(task_id, "notify_failed", str(exc))

    def _run_agenticseek(self, prompt: str) -> str:
        req = urllib.request.Request(
            Config.agenticseek_url + "/query",
            data=json.dumps({"query": prompt, "tts_enabled": False}).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {Config.agenticseek_token}",
                     "X-API-Token": Config.agenticseek_token},
        )
        try:
            with urllib.request.urlopen(req, timeout=900) as resp:
                data = json.loads(resp.read())
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"agenticSeek request failed: {exc}") from exc
        return data.get("answer") or "(agenticSeek returned no answer)"

    def _memory_worker(self) -> None:
        while not self._stop.is_set():
            try:
                agent_key, prompt, answer = self._memory_jobs.get(timeout=2)
            except queue.Empty:
                continue
            # Let real tasks use the GPU first.
            while self.current_task_id is not None and not self._stop.is_set():
                time.sleep(1)
            try:
                saved = self.memory.extract(agent_key, prompt, answer)
                if saved:
                    self._emit(None, "memory", f"saved {len(saved)}: " + "; ".join(saved)[:200], "memory")
            except Exception as exc:  # noqa: BLE001
                self._emit(None, "memory_failed", str(exc), "memory")

    def _maintenance(self) -> None:
        while not self._stop.wait(Config.memory_interval_min * 60):
            try:
                stats = self.memory.maintain()
                self._emit(None, "maintenance", json.dumps(stats), "memory")
            except Exception as exc:  # noqa: BLE001
                self._emit(None, "maintenance_failed", str(exc), "memory")


# Re-exported for the server.
roster = agents_mod.AGENTS
