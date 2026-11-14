"""Telegram front end: long-polls for messages and replies when tasks finish.

Only chat IDs in TELEGRAM_ALLOWED_CHAT_IDS can use the bot. Messages from anyone
else get their chat ID echoed back once so you can add yourself, and nothing runs.
"""
import json
import threading
import time
import urllib.parse
import urllib.request

from .agents import AGENTS
from .config import Config
from .guard import redact

API = "https://api.telegram.org/bot{token}/{method}"


class TelegramBot:
    def __init__(self, orchestrator, token: str = Config.telegram_token,
                 allowed: set[str] | None = None):
        self.orch = orchestrator
        self.token = token
        self.allowed = allowed if allowed is not None else Config.telegram_allowed
        self.offset = 0
        self._warned: set[str] = set()
        orchestrator.notifiers.append(self.on_task_done)

    def _call(self, method: str, params: dict, timeout: int = 40) -> dict:
        data = urllib.parse.urlencode(params).encode()
        req = urllib.request.Request(API.format(token=self.token, method=method), data=data)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())

    def send(self, chat_id: str, text: str) -> None:
        text, _ = redact(text)
        for i in range(0, max(len(text), 1), 4000):
            self._call("sendMessage", {"chat_id": chat_id, "text": text[i:i + 4000]}, timeout=20)

    def handle(self, message: dict) -> None:
        chat_id = str(message.get("chat", {}).get("id", ""))
        text = (message.get("text") or "").strip()
        if not chat_id or not text:
            return
        if chat_id not in self.allowed:
            if chat_id not in self._warned:
                self._warned.add(chat_id)
                self.send(chat_id, f"Not authorised. Your chat ID is {chat_id}; add it to "
                                   "TELEGRAM_ALLOWED_CHAT_IDS to use this bot.")
            return
        agent = "auto"
        if text.startswith("/"):
            command, _, rest = text[1:].partition(" ")
            command = command.split("@")[0].lower()
            if command in ("start", "help"):
                self.send(chat_id, "Send any task. Prefix with /<agent> to pick one: "
                          + ", ".join(f"/{k}" for k in AGENTS) + ". /status shows the queue.")
                return
            if command == "status":
                rows = self.orch.db.all(
                    "SELECT id, status, agent, prompt FROM tasks WHERE status NOT IN"
                    " ('complete','failed','cancelled') ORDER BY id")
                self.send(chat_id, "\n".join(
                    f"#{r['id']} {r['status']} {r['agent'] or ''}: {r['prompt'][:60]}" for r in rows
                ) or "Queue is empty.")
                return
            if command in AGENTS and rest.strip():
                agent, text = command, rest.strip()
        task_id = self.orch.submit(text, agent, "telegram", chat_id)
        self.send(chat_id, f"Queued as #{task_id}.")

    def on_task_done(self, task: dict) -> None:
        if task["source"] != "telegram" or not task["chat_id"]:
            return
        if task["status"] == "complete":
            self.send(task["chat_id"], task["result"] or "(no answer)")
        elif task["status"] == "failed":
            self.send(task["chat_id"], f"Task #{task['id']} failed: {task['error']}")

    def poll_forever(self) -> None:
        while True:
            try:
                data = self._call("getUpdates", {"offset": self.offset, "timeout": 30}, timeout=40)
                for update in data.get("result", []):
                    self.offset = update["update_id"] + 1
                    if "message" in update:
                        self.handle(update["message"])
            except Exception as exc:  # noqa: BLE001 - keep polling through network blips
                self.orch.db.log("telegram", "error", str(exc))
                time.sleep(5)

    def start(self) -> None:
        threading.Thread(target=self.poll_forever, name="hq-telegram", daemon=True).start()
