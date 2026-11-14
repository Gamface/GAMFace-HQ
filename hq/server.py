"""HTTP API + dashboard. Run with:  python -m hq.server"""
import json
import queue
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .agents import AGENTS
from .config import ROOT, Config
from .db import DB
from .llm import Ollama
from .orchestrator import Orchestrator

WEB = ROOT / "web"


def make_handler(orch: Orchestrator):
    class Handler(BaseHTTPRequestHandler):
        server_version = "GAMFaceHQ/1.0"

        def log_message(self, fmt, *args):  # quieter console
            pass

        def _json(self, data, status: int = 200) -> None:
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                return {}

        def _same_origin(self) -> bool:
            # Block other websites from posting tasks to your local HQ.
            origin = self.headers.get("Origin")
            if not origin:
                return True
            host = self.headers.get("Host", "")
            return origin.split("://", 1)[-1] == host

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                body = (WEB / "index.html").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif path == "/api/system":
                status = orch.llm.status()
                queued = orch.db.one("SELECT COUNT(*) AS n FROM tasks WHERE status='queued'")["n"]
                self._json({**status, "url": Config.ollama_url, "model": Config.model,
                            "fastModel": Config.fast_model, "running": orch.current_task_id,
                            "queued": queued, "telegram": bool(Config.telegram_token),
                            "obsidian": bool(Config.obsidian_vault)})
            elif path == "/api/agents":
                self._json([{"key": a.key, "name": a.name, "role": a.role,
                             "canDelegate": a.can_delegate} for a in AGENTS.values()])
            elif path == "/api/tasks":
                self._json(orch.db.recent_tasks(60))
            elif m := re.fullmatch(r"/api/tasks/(\d+)", path):
                task = orch.db.task(int(m.group(1)))
                if not task:
                    return self._json({"error": "not found"}, 404)
                self._json({**task, "children": orch.db.children(task["id"])})
            elif path == "/api/hive":
                self._json(orch.db.hive(100))
            elif path == "/api/memories":
                self._json(orch.memory.list())
            elif path == "/api/events":
                self._sse()
            else:
                self._json({"error": "not found"}, 404)

        def do_POST(self):
            if not self._same_origin():
                return self._json({"error": "cross-origin request blocked"}, 403)
            path = self.path.split("?", 1)[0]
            body = self._body()
            if path == "/api/tasks":
                prompt = str(body.get("prompt", "")).strip()
                if not prompt:
                    return self._json({"error": "prompt is required"}, 400)
                task_id = orch.submit(prompt, str(body.get("agent", "auto")), "dashboard")
                self._json({"id": task_id}, 201)
            elif m := re.fullmatch(r"/api/tasks/(\d+)/cancel", path):
                self._json({"cancelled": orch.cancel(int(m.group(1)))})
            elif path == "/api/memories":
                mid = orch.memory.add(str(body.get("text", "")), str(body.get("agent", "shared")),
                                      float(body.get("importance", 0.7)), bool(body.get("pinned", True)))
                self._json({"id": mid}, 201 if mid else 400)
            elif m := re.fullmatch(r"/api/memories/(\d+)/(pin|unpin|delete)", path):
                mid, action = int(m.group(1)), m.group(2)
                if action == "delete":
                    orch.memory.delete(mid)
                else:
                    orch.memory.pin(mid, action == "pin")
                self._json({"ok": True})
            elif path == "/api/memories/maintain":
                self._json(orch.memory.maintain())
            else:
                self._json({"error": "not found"}, 404)

        def _sse(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q = orch.bus.subscribe()
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    try:
                        event = q.get(timeout=15)
                        self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                orch.bus.unsubscribe(q)

    return Handler


def build(db_path=None, llm=None) -> Orchestrator:
    return Orchestrator(DB(db_path or Config.db_path), llm or Ollama())


def main() -> None:
    orch = build()
    orch.start()
    if Config.telegram_token:
        from .telegram import TelegramBot
        TelegramBot(orch).start()
        print("Telegram bot polling" + ("" if Config.telegram_allowed else
              " (no allowed chat IDs yet: message the bot to get yours)"))
    server = ThreadingHTTPServer((Config.host, Config.port), make_handler(orch))
    server.daemon_threads = True
    print(f"GAMFace HQ running at http://{Config.host}:{Config.port}  (model {Config.model} via {Config.ollama_url})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping")
        orch.stop()
        sys.exit(0)


if __name__ == "__main__":
    main()
