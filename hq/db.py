"""SQLite storage: tasks, the shared hive-mind activity log, and memories."""
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER,
    depth INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'dashboard',
    chat_id TEXT,
    requested_agent TEXT NOT NULL DEFAULT 'auto',
    agent TEXT,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    result TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS hive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    agent TEXT NOT NULL,
    task_id INTEGER,
    event TEXT NOT NULL,
    summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL DEFAULT 'shared',
    text TEXT NOT NULL,
    importance REAL NOT NULL DEFAULT 0.5,
    pinned INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    last_used REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_hive_ts ON hive(ts);
"""


class DB:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.executescript(SCHEMA)
            # Tasks left running by a crash go back in the queue instead of vanishing.
            self._conn.execute(
                "UPDATE tasks SET status='queued' WHERE status='running'"
            )
            self._conn.commit()

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def all(self, sql: str, params: tuple = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def one(self, sql: str, params: tuple = ()) -> dict | None:
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
            return dict(row) if row else None

    # ---- tasks -------------------------------------------------------------
    def add_task(self, prompt: str, requested_agent: str = "auto", source: str = "dashboard",
                 chat_id: str | None = None, parent_id: int | None = None, depth: int = 0) -> int:
        now = time.time()
        cur = self.execute(
            "INSERT INTO tasks (parent_id, depth, source, chat_id, requested_agent, prompt,"
            " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (parent_id, depth, source, chat_id, requested_agent, prompt, now, now),
        )
        return cur.lastrowid

    def update_task(self, task_id: int, **fields) -> None:
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        self.execute(f"UPDATE tasks SET {cols} WHERE id=?", (*fields.values(), task_id))

    def task(self, task_id: int) -> dict | None:
        return self.one("SELECT * FROM tasks WHERE id=?", (task_id,))

    def next_queued(self) -> dict | None:
        # Delegated sub-tasks (deeper) run before new top-level work.
        return self.one(
            "SELECT * FROM tasks WHERE status='queued' ORDER BY depth DESC, id ASC LIMIT 1"
        )

    def recent_tasks(self, limit: int = 50) -> list[dict]:
        return self.all("SELECT * FROM tasks ORDER BY id DESC LIMIT ?", (limit,))

    def children(self, task_id: int) -> list[dict]:
        return self.all("SELECT * FROM tasks WHERE parent_id=? ORDER BY id", (task_id,))

    # ---- hive mind ---------------------------------------------------------
    def log(self, agent: str, event: str, summary: str, task_id: int | None = None) -> None:
        self.execute(
            "INSERT INTO hive (ts, agent, task_id, event, summary) VALUES (?,?,?,?,?)",
            (time.time(), agent, task_id, event, summary[:500]),
        )

    def hive(self, limit: int = 30) -> list[dict]:
        rows = self.all("SELECT * FROM hive ORDER BY id DESC LIMIT ?", (limit,))
        return list(reversed(rows))
