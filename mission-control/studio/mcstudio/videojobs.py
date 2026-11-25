"""The video half of the studio: Jarvis Studio's video workflows (mcstudio/js/video) run as
studio jobs. Clips, photos and recordings you upload live in data/studio/media/<folder>/."""

from __future__ import annotations

import base64
import re
import time
from pathlib import Path

from .store import DATA, slug

MEDIA_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".jpg", ".jpeg", ".png", ".webp", ".wav", ".mp3", ".m4a", ".flac", ".ogg", ".txt"}
FOLDER = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
MAX_MEDIA = 200 * 1024 * 1024

VIDEO_KINDS = ("music_video", "beat_edit", "shorts", "narrated", "captions", "performance", "explainer")

ALLOWED = {
    "music_video": {"song", "style", "aspect", "title", "lyrics", "start", "end", "background"},
    "beat_edit": {"media", "song", "aspect", "pace", "title", "start", "max_len", "lyrics"},
    "shorts": {"source", "song", "platforms", "length", "start", "caption", "title"},
    "narrated": {"script", "title", "media", "voice", "music", "aspect", "music_gain", "voice_speed"},
    "captions": {"video", "style", "burn"},
    "performance": {"recording", "song", "lyrics", "aspect"},
    "explainer": {"title", "script", "aspect", "voice", "voice_speed", "music", "style", "captions", "transition", "motion", "intro", "sfx", "seed"},
}

LABELS = {"music_video": "Music video", "beat_edit": "Beat-cut edit", "shorts": "Shorts", "narrated": "Narrated video", "captions": "Captions", "performance": "Performance video", "explainer": "Explainer"}


def media_root(root: Path | None = None) -> Path:
    d = (root or DATA) / "media"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_media(folder: str, filename: str, data_b64: str, root: Path | None = None) -> dict:
    folder = slug(folder or "uploads", "uploads")[:40]
    name = Path(filename or "file").name
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    if ext not in MEDIA_EXT:
        raise ValueError(f"{name}: use a video, photo, audio or .txt file")
    raw = base64.b64decode(data_b64.split(",", 1)[1] if data_b64.startswith("data:") else data_b64, validate=True)
    if not raw:
        raise ValueError(f"{name} is empty")
    if len(raw) > MAX_MEDIA:
        raise ValueError(f"{name} is over {MAX_MEDIA // 1024 // 1024} MB")
    d = media_root(root) / folder
    d.mkdir(parents=True, exist_ok=True)
    dest = d / f"{slug(stem, 'file')}{ext}"
    n = 2
    while dest.exists():
        dest = d / f"{slug(stem, 'file')}-{n}{ext}"
        n += 1
    dest.write_bytes(raw)
    return {"folder": folder, "name": dest.name, "path": str(dest.relative_to(root or DATA)), "bytes": len(raw)}


def list_media(root: Path | None = None) -> list[dict]:
    base = media_root(root)
    out = []
    for d in sorted(base.iterdir()):
        if d.is_dir():
            files = sorted(f for f in d.iterdir() if f.is_file())
            out.append({"folder": d.name, "files": [{"name": f.name, "path": str(f.relative_to(root or DATA)), "bytes": f.stat().st_size} for f in files]})
    return out


def media_path(rel: str, root: Path | None = None, folder: bool = False) -> Path:
    """A media file (or folder) by its path under the data folder; never outside media/."""
    base = media_root(root).resolve()
    p = ((root or DATA) / str(rel)).resolve() if "/" in str(rel) else (base / str(rel)).resolve()
    if base not in p.parents and p != base:
        raise ValueError("That isn't in the studio's media")
    if folder and not p.is_dir():
        raise ValueError(f"No media folder called {rel}")
    if not folder and not p.is_file():
        raise ValueError(f"No media file {rel}")
    return p


def check(kind: str, p: dict, library) -> str | None:
    def song_ok(key: str, required: bool) -> str | None:
        sid = p.get(key)
        if not sid:
            return "Pick a song" if required else None
        meta = library.get(str(sid))
        if meta is None:
            return "Pick a song from the library"
        if meta.get("status") != "ready":
            return f"“{meta['title']}” hasn't been split into stems yet"
        return None

    root = library.root.parent  # the studio's data folder

    def mp(rel: str, folder: bool = False) -> Path:
        return media_path(rel, root, folder)

    try:
        if kind == "music_video":
            return song_ok("song", True)
        if kind == "beat_edit":
            mp(str(p.get("media", "")), folder=True)
            return song_ok("song", True)
        if kind == "shorts":
            if p.get("source"):
                mp(str(p["source"]))
                return None
            return song_ok("song", True)
        if kind == "narrated":
            if len(str(p.get("script", "")).strip()) < 10:
                return "Write the script (one paragraph per slide)"
            if p.get("media"):
                mp(str(p["media"]), folder=True)
            return song_ok("music", False)
        if kind == "captions":
            mp(str(p.get("video", "")))
            return None
        if kind == "performance":
            mp(str(p.get("recording", "")))
            return song_ok("song", True)
        if kind == "explainer":
            if not str(p.get("title", "")).strip():
                return "Give the explainer a title"
            if len(str(p.get("script", "")).strip()) < 20:
                return "Write the script: one paragraph per scene, '# Chapter' lines for chapters"
            return song_ok("music", False)
    except ValueError as e:
        return str(e)
    return f"Unknown video job {kind}"


def _snapshot(base: Path) -> dict[Path, float]:
    return {f: f.stat().st_mtime for f in base.rglob("*") if f.is_file()} if base.exists() else {}


def _finished(base: Path, before: dict[Path, float], data: Path) -> list[str]:
    """The files a job made or changed, without the working files (caches, stems, SVGs)."""
    out = []
    for f, m in _snapshot(base).items():
        if before.get(f) == m:
            continue
        if any(part in ("cache", "work") for part in f.relative_to(base).parts) or f.suffix in (".svg", ".json", ".txt") and f.name not in ("chapters.txt",):
            continue
        if f.name.endswith(".raw.wav") or re.match(r"^(voice|seg|clip|part|song-mix|mix|backing|stem)[-_]", f.name):
            continue
        out.append(str(f.relative_to(data)))
    return sorted(out, key=lambda r: (not r.endswith(".mp4"), r))


def run(kind: str, p: dict, data: Path, progress) -> dict:
    """Runs one video workflow. Returns {message, files}."""
    from .js import config as js_config
    from .js.video import common as vcommon
    from .js.video import explainer, workflows as vw

    # Finished videos go under this worker's data folder (the Studio page lists outputs/)
    vcommon.VIDEO_OUT = js_config.OUT_ROOT = data / "outputs"
    js_config.STATE_DIR = vw.STATE_DIR = data / "state"

    base = data / "outputs"
    before = _snapshot(base)
    started = time.time()
    abs_media = lambda rel, folder=False: str(media_path(rel, data, folder))  # noqa: E731
    progress(f"{LABELS[kind].lower()}: working")
    if kind == "music_video":
        report = vw.music_video(str(p["song"]), p.get("style") or "stems", p.get("aspect") or "16:9", p.get("title") or None, None,
                                abs_media(p["background"]) if p.get("background") else None, bool(p.get("lyrics", True)), None,
                                _num(p.get("start")), _num(p.get("end")))
    elif kind == "beat_edit":
        report = vw.auto_edit(abs_media(p["media"], True), str(p["song"]), p.get("aspect") or "16:9", p.get("pace") or "medium",
                              p.get("title") or None, None, _num(p.get("start")), _num(p.get("max_len")), bool(p.get("lyrics", False)))
    elif kind == "shorts":
        source = abs_media(p["source"]) if p.get("source") else str(p["song"])
        report = vw.shorts(source, p.get("platforms") or ["shorts", "square"], float(p.get("length") or 30), _num(p.get("start")), None,
                           p.get("caption") or "auto", str(p["song"]) if p.get("source") and p.get("song") else None, p.get("title") or None)
    elif kind == "narrated":
        report = vw.narrated(str(p["script"]), p.get("title") or "Narrated video", abs_media(p["media"], True) if p.get("media") else None,
                             p.get("voice") or None, str(p["music"]) if p.get("music") else None, p.get("aspect") or "16:9",
                             float(p.get("music_gain") or 0.35), float(p.get("voice_speed") or 1.0))
    elif kind == "captions":
        report = vw.captions(abs_media(p["video"]), p.get("style") or "bottom", bool(p.get("burn", True)))
    elif kind == "performance":
        report = vw.performance(abs_media(p["recording"]), str(p["song"]), None, bool(p.get("lyrics", True)), aspect=p.get("aspect") or None)
    elif kind == "explainer":
        title = " ".join(str(p["title"]).split())[:80]
        explainer.create(title, str(p["script"]), None, p.get("aspect") or "16:9", p.get("voice") or None, float(p.get("voice_speed") or 1.0),
                         str(p["music"]) if p.get("music") else None, p.get("style") or None, _int(p.get("seed")), bool(p.get("intro", True)),
                         p.get("captions") or None, p.get("transition") or None, p.get("motion") or None, bool(p.get("sfx", True)))
        report = explainer.build(title, lambda step, frac=None: progress(f"explainer: {step}" + (f" ({int(frac * 100)}%)" if frac is not None else "")))
    else:
        raise ValueError(f"Unknown video job {kind}")
    files = _finished(base, before, data)
    message = str(report).replace(str(data) + "/", "")
    first = message.strip().splitlines()[0] if message.strip() else f"{LABELS[kind]} done"
    return {"message": f"{first} ({time.time() - started:.0f} s)", "report": message[:4000], "files": files}


def _num(v):
    return None if v in (None, "") else float(v)


def _int(v):
    return None if v in (None, "") else int(v)
