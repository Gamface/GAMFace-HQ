"""Mission Control Studio: songs, stems, practice tracks, karaoke, sheet music and DAW exports.

Only the harness talks to it (the render network). The graphics-card work goes to ComfyUI on
Windows (COMFY_URL); everything else runs here on the CPU.

  GET  /health                        what's available (ComfyUI, ACE-Step, GPU stems, MuseScore)
  GET  /songs, /songs/<id>            the library
  POST /songs {title, filename, data} add audio (base64); it's split into stems straight away
  DELETE /songs/<id>
  GET  /import?q=words                files in the shared music folder (MUSIC_DIR) that match
  POST /songs/import {path, title?, split?}   add one of them by its path on the PC
  POST /jobs {type, ...}              split | song | vocals | practice | karaoke | sheet | daw
  GET  /jobs, /jobs/<id>; POST /jobs/<id>/cancel
  GET  /outputs                       finished work, newest first
  GET  /files/<path>                  any file under the data folder (byte ranges for players)
"""

from __future__ import annotations

import base64
import binascii
import json
import mimetypes
import os
import shutil
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mcstudio import sheet
from mcstudio.comfy import STEM_NODE, Comfy
from mcstudio.store import DATA, Jobs, Library, outputs
from mcstudio import imports, stock, videojobs
from mcstudio.worker import Worker, check_params, job_title, save_upload

MAX_UPLOAD = 150 * 1024 * 1024
# Clips and recordings for the video workflows can be bigger than songs
MAX_BODY = int(videojobs.MAX_MEDIA * 1.4) + 1024
COMFY_URL = os.environ.get("COMFY_URL", "http://host.docker.internal:8188")
VOICE_URL = os.environ.get("VOICE_URL", "")


def drop_root() -> None:
    """Started as root only to own the data folder Docker created; then runs as the studio user."""
    if hasattr(os, "getuid") and os.getuid() == 0:
        uid = int(os.environ.get("STUDIO_UID", "1000"))
        DATA.mkdir(parents=True, exist_ok=True)
        for root, dirs, files in os.walk(DATA):
            for n in [root, *(os.path.join(root, d) for d in dirs), *(os.path.join(root, f) for f in files)]:
                try:
                    os.chown(n, uid, uid)
                except OSError:
                    pass
        os.setgid(uid)
        os.setuid(uid)


library: Library
jobs: Jobs
worker: Worker
comfy = Comfy(COMFY_URL) if COMFY_URL else None
health_cache: dict = {"at": 0.0, "value": {}}


def health() -> dict:
    """Checked at most every 10 seconds (each check asks ComfyUI)."""
    if time.time() - health_cache["at"] < 10:
        return health_cache["value"]
    up = bool(comfy and comfy.running())
    value = {
        "ok": True,
        "comfy": up,
        "comfyUrl": COMFY_URL,
        "aceStep": comfy.ace_checkpoint() if up else None,
        "gpuStems": bool(up and not worker.gpu_stems_failed and comfy.node_info(STEM_NODE)),
        "gpuStemsError": worker.gpu_stems_failed,
        "musescore": bool(sheet.musescore()),
        "rubberband": bool(shutil.which("rubberband")),
        "voice": bool(VOICE_URL),
        # Free stock footage for themed music videos
        "stock": stock.keys(),
        # The shared music folder songs can be added from by path
        "importFolder": imports.available(),
    }
    health_cache.update(at=time.time(), value=value)
    return value


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if "/health" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def send(self, status: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self) -> dict:
        size = int(self.headers.get("Content-Length") or 0)
        if size > MAX_BODY:
            raise ValueError("Request too large")
        raw = self.rfile.read(size) or b"{}"
        try:
            out = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError("Invalid JSON") from e
        if not isinstance(out, dict):
            raise ValueError("Send a JSON object")
        return out

    def parts(self) -> list[str]:
        return [p for p in self.path.split("?")[0].split("/") if p]

    # --- GET ------------------------------------------------------------------------------

    def do_GET(self):
        p = self.parts()
        try:
            if p == ["health"]:
                return self.send(200, health())
            if p == ["songs"]:
                return self.send(200, {"songs": library.list()})
            if len(p) == 2 and p[0] == "songs":
                m = library.get(p[1])
                return self.send(200, m) if m else self.send(404, {"error": "Song not found"})
            if p == ["jobs"]:
                return self.send(200, {"jobs": jobs.list()})
            if len(p) == 2 and p[0] == "jobs":
                j = jobs.get(p[1])
                return self.send(200, j) if j else self.send(404, {"error": "Job not found"})
            if p == ["outputs"]:
                return self.send(200, {"outputs": outputs(DATA)})
            if p == ["media"]:
                return self.send(200, {"media": videojobs.list_media(DATA)})
            if p == ["import"]:
                from urllib.parse import parse_qs, urlparse

                if not imports.available():
                    return self.send(200, {"files": [], "error": "No music folder is shared with the studio: set MUSIC_DIR in mission-control/.env"})
                q = parse_qs(urlparse(self.path).query).get("q", [""])[0][:200]
                return self.send(200, {"files": imports.find(q)})
            if len(p) >= 2 and p[0] == "files":
                return self.file("/".join(p[1:]))
            return self.send(404, {"error": "Not found"})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self.send(500, {"error": str(e)})

    def file(self, rel: str) -> None:
        """A file under the data folder; never outside it. Answers byte ranges so players can seek."""
        root = DATA.resolve()
        target = (root / rel).resolve()
        if root not in target.parents or not target.is_file() or target.name.endswith(".json"):
            return self.send(404, {"error": "File not found"})
        size = target.stat().st_size
        ctype = {".lrc": "text/plain; charset=utf-8", ".musicxml": "application/vnd.recordare.musicxml+xml", ".mid": "audio/midi"}.get(target.suffix) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range", "")
        partial = False
        if rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            try:
                if a:
                    start, end = int(a), (int(b) if b else size - 1)
                elif b:
                    start, end = max(0, size - int(b)), size - 1
                partial = True
            except ValueError:
                pass
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            end = min(end, size - 1)
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with open(target, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 16, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    # --- POST / DELETE ----------------------------------------------------------------------

    def do_POST(self):
        p = self.parts()
        try:
            body = self.body()
            if p == ["songs"]:
                data = str(body.get("data") or "")
                data = data.split(",", 1)[1] if data.startswith("data:") else data
                try:
                    raw = base64.b64decode(data, validate=True)
                except (binascii.Error, ValueError):
                    return self.send(400, {"error": "Send the audio as base64"})
                if not raw:
                    return self.send(400, {"error": "The file is empty"})
                if len(raw) > MAX_UPLOAD:  # songs; media has its own limit
                    return self.send(413, {"error": f"Files can be at most {MAX_UPLOAD // 1024 // 1024} MB"})
                meta = save_upload(library, str(body.get("title") or ""), raw, str(body.get("filename") or "upload"))
                if body.get("split", True):
                    jobs.add("split", {"song": meta["id"]}, f"Split: {meta['title']}")
                    worker.wake.set()
                return self.send(201, meta)
            if p == ["songs", "import"]:
                src = imports.resolve(str(body.get("path") or ""))
                if src.stat().st_size > MAX_UPLOAD:
                    return self.send(413, {"error": f"Files can be at most {MAX_UPLOAD // 1024 // 1024} MB"})
                meta = save_upload(library, str(body.get("title") or "") or src.stem, src.read_bytes(), src.name)
                if body.get("split", True):
                    jobs.add("split", {"song": meta["id"]}, f"Split: {meta['title']}")
                    worker.wake.set()
                return self.send(201, {**meta, "importedFrom": str(src.relative_to(imports.IMPORT_DIR))})
            if p == ["jobs"]:
                kind = str(body.pop("type", ""))
                err = check_params(kind, body, library)
                if err:
                    return self.send(400, {"error": err})
                params = {k: v for k, v in body.items() if k in ALLOWED[kind]}
                job = jobs.add(kind, params, job_title(kind, params, library))
                worker.wake.set()
                return self.send(201, job)
            if p == ["media"]:
                try:
                    return self.send(201, videojobs.save_media(str(body.get("folder") or ""), str(body.get("filename") or ""), str(body.get("data") or ""), DATA))
                except (binascii.Error, ValueError) as e:
                    return self.send(400, {"error": str(e) if isinstance(e, ValueError) and not isinstance(e, binascii.Error) else "Send the file as base64"})
            if len(p) == 3 and p[0] == "jobs" and p[2] == "cancel":
                err = jobs.cancel(p[1])
                return self.send(400 if err else 200, {"error": err} if err else {"ok": True})
            return self.send(404, {"error": "Not found"})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self.send(500, {"error": str(e)})

    def do_DELETE(self):
        p = self.parts()
        if len(p) == 2 and p[0] == "songs":
            if any(j["status"] in ("queued", "running") and j["params"].get("song") == p[1] for j in jobs.list(300)):
                return self.send(409, {"error": "That song has a job running or waiting"})
            try:
                ok = library.delete(p[1])
            except KeyError:
                ok = False
            return self.send(200, {"ok": True}) if ok else self.send(404, {"error": "Song not found"})
        return self.send(404, {"error": "Not found"})


# The parameters each job type takes (anything else in the request is dropped)
ALLOWED = {
    "split": {"song"},
    "song": {"prompt", "title", "lyrics", "seconds", "bpm", "key", "timesig", "language", "seed", "split"},
    "vocals": {"song", "lyrics", "prompt", "strength", "language", "seed", "title", "vocal_level", "split"},
    "practice": {"song", "gains", "speed", "semitones", "start", "end"},
    "karaoke": {"song", "semitones", "lyrics", "keep_backing_vocals"},
    "sheet": {"song", "parts"},
    "daw": {"song"},
    **videojobs.ALLOWED,
}


def main() -> None:
    global library, jobs, worker
    drop_root()
    library = Library(DATA)
    jobs = Jobs(DATA)
    worker = Worker(library, jobs, comfy, VOICE_URL or None, DATA)
    worker.start()
    port = int(os.environ.get("PORT", "3050"))
    print(f"Studio on :{port}; ComfyUI at {COMFY_URL}; data in {DATA}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
