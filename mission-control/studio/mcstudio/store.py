"""Where the studio keeps things, all under /data (mission-control/data/studio on the PC):

  library/<id>/meta.json, original.wav, stems/<stem>.wav    songs you added or made
  outputs/<kind>/<name>/...                                  practice tracks, karaoke, sheet music, DAW exports
  jobs.json                                                  the job list
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import threading
import time
import unicodedata
from pathlib import Path

DATA = Path(os.environ.get("STUDIO_DATA", "/data"))
SONG_ID = re.compile(r"^[a-f0-9]{12}$")
JOB_ID = re.compile(r"^[a-f0-9]{12}$")


def slug(s: str, fallback: str = "untitled") -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:50].strip("-")
    return s or fallback


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, path)


class Library:
    def __init__(self, root: Path | None = None):
        self.root = (root or DATA) / "library"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def dir(self, sid: str) -> Path:
        if not SONG_ID.match(sid):
            raise KeyError(sid)
        return self.root / sid

    def get(self, sid: str) -> dict | None:
        try:
            return json.loads((self.dir(sid) / "meta.json").read_text())
        except (KeyError, FileNotFoundError, json.JSONDecodeError):
            return None

    def list(self) -> list[dict]:
        out = []
        for d in self.root.iterdir():
            if d.is_dir() and SONG_ID.match(d.name):
                m = self.get(d.name)
                if m:
                    out.append(m)
        return sorted(out, key=lambda m: m.get("createdAt", 0), reverse=True)

    def create(self, title: str, source: str, **extra) -> dict:
        sid = secrets.token_hex(6)
        meta = {"id": sid, "title": title.strip()[:200] or "Untitled", "source": source, "status": "new", "stems": [], "createdAt": int(time.time() * 1000), **extra}
        self.dir(sid).mkdir(parents=True)
        self.save(meta)
        return meta

    def save(self, meta: dict) -> None:
        with self.lock:
            meta["updatedAt"] = int(time.time() * 1000)
            write_json(self.dir(meta["id"]) / "meta.json", meta)

    def update(self, sid: str, **fields) -> dict:
        meta = self.get(sid)
        if meta is None:
            raise KeyError(sid)
        meta.update(fields)
        self.save(meta)
        return meta

    def delete(self, sid: str) -> bool:
        d = self.dir(sid)
        if not d.exists():
            return False
        shutil.rmtree(d)
        return True

    def original(self, sid: str) -> Path:
        return self.dir(sid) / "original.wav"

    def stems(self, sid: str) -> dict[str, Path]:
        d = self.dir(sid) / "stems"
        meta = self.get(sid) or {}
        return {n: d / f"{n}.wav" for n in meta.get("stems", []) if (d / f"{n}.wav").exists()}


class Jobs:
    """The job list, saved after every change. Jobs cut off by a restart are marked interrupted."""

    def __init__(self, root: Path | None = None):
        self.file = (root or DATA) / "jobs.json"
        self.lock = threading.RLock()
        self.cancelled: set[str] = set()
        try:
            self.items: list[dict] = json.loads(self.file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            self.items = []
        for j in self.items:
            if j["status"] in ("queued", "running"):
                j.update(status="failed", error="Interrupted by a restart: run it again", finishedAt=int(time.time() * 1000))
        self.items = self.items[-300:]
        self.save()

    def save(self) -> None:
        with self.lock:
            write_json(self.file, self.items)

    def add(self, kind: str, params: dict, title: str) -> dict:
        job = {"id": secrets.token_hex(6), "type": kind, "title": title, "params": params, "status": "queued", "progress": "", "createdAt": int(time.time() * 1000)}
        with self.lock:
            self.items.append(job)
            self.save()
        return job

    def get(self, jid: str) -> dict | None:
        with self.lock:
            return next((j for j in self.items if j["id"] == jid), None)

    def list(self, limit: int = 100) -> list[dict]:
        with self.lock:
            return list(reversed(self.items[-limit:]))

    def next_queued(self) -> dict | None:
        with self.lock:
            return next((j for j in self.items if j["status"] == "queued"), None)

    def update(self, job: dict, **fields) -> None:
        with self.lock:
            job.update(fields)
            self.save()

    def cancel(self, jid: str) -> str | None:
        with self.lock:
            j = self.get(jid)
            if not j:
                return "Job not found"
            if j["status"] == "queued":
                self.update(j, status="cancelled", finishedAt=int(time.time() * 1000))
            elif j["status"] == "running":
                self.cancelled.add(jid)
            else:
                return "That job has already finished"
            return None


def outputs(root: Path | None = None, limit: int = 100) -> list[dict]:
    """Finished work, newest first: one entry per output folder with its files."""
    base = (root or DATA) / "outputs"
    found = []
    if base.exists():
        for kind in base.iterdir():
            if not kind.is_dir():
                continue
            for d in kind.iterdir():
                if d.is_dir():
                    files = sorted(f for f in d.rglob("*") if f.is_file())
                    if files:
                        found.append({"kind": kind.name, "name": d.name, "at": int(d.stat().st_mtime * 1000), "files": [str(f.relative_to(root or DATA)) for f in files]})
    return sorted(found, key=lambda o: o["at"], reverse=True)[:limit]
