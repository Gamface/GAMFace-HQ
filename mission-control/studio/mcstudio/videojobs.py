"""The video half of the studio: Jarvis Studio's video workflows (mcstudio/js/video) run as
studio jobs. Clips, photos and recordings you upload live in data/studio/media/<folder>/."""

from __future__ import annotations

import base64
import re
import time
from pathlib import Path

from . import stock
from .store import DATA, slug

MEDIA_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".jpg", ".jpeg", ".png", ".webp", ".wav", ".mp3", ".m4a", ".flac", ".ogg", ".txt"}
FOLDER = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
MAX_MEDIA = 200 * 1024 * 1024

VIDEO_KINDS = ("themed_video", "music_video", "beat_edit", "shorts", "narrated", "captions", "performance", "explainer")

ALLOWED = {
    "themed_video": {"song", "theme", "sources", "media", "aspect", "pace", "count", "title", "start", "max_len", "lyrics", "video_share"},
    "music_video": {"song", "style", "aspect", "title", "lyrics", "start", "end", "background"},
    "beat_edit": {"media", "song", "aspect", "pace", "title", "start", "max_len", "lyrics"},
    "shorts": {"source", "song", "platforms", "length", "start", "caption", "title"},
    "narrated": {"script", "title", "media", "voice", "music", "aspect", "music_gain", "voice_speed"},
    "captions": {"video", "style", "burn"},
    "performance": {"recording", "song", "lyrics", "aspect"},
    "explainer": {"title", "script", "aspect", "voice", "voice_speed", "music", "style", "captions", "transition", "motion", "intro", "sfx", "seed"},
}

LABELS = {"themed_video": "Themed music video", "music_video": "Music video", "beat_edit": "Beat-cut edit", "shorts": "Shorts", "narrated": "Narrated video", "captions": "Captions", "performance": "Performance video", "explainer": "Explainer"}


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
        if kind == "themed_video":
            sources = p.get("sources") or ["stock"]
            if not isinstance(sources, list) or not set(sources) <= {"stock", "ai", "media"}:
                return "Sources are stock, ai and media"
            if "media" in sources:
                mp(str(p.get("media", "")), folder=True)
            if sources == ["stock"] and not any(stock.keys().values()):
                return "Stock footage needs a free Pexels or Pixabay API key (PEXELS_API_KEY or PIXABAY_API_KEY in .env), or pick AI photos or your media"
            return song_ok("song", True)
    except ValueError as e:
        return str(e)
    return f"Unknown video job {kind}"


def _snapshot(base: Path) -> dict[Path, float]:
    return {f: f.stat().st_mtime for f in base.rglob("*") if f.is_file()} if base.exists() else {}


def _finished(base: Path, before: dict[Path, float], data: Path) -> list[str]:
    """The finished files a job made or changed: videos, subtitles, timelines, thumbnails and
    YouTube chapters. Working files (mixes, title cards, overlays, scene caches) are left out."""
    out = []
    for f, m in _snapshot(base).items():
        if before.get(f) == m or "cache" in f.relative_to(base).parts:
            continue
        keep = f.suffix.lower() in (".mp4", ".srt", ".otio", ".lrc") or f.name == "chapters.txt" or (f.name.startswith("thumbnail") and f.suffix.lower() in (".png", ".jpg"))
        if keep and not re.match(r"^(seg|part)-\d", f.name):
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
    elif kind == "themed_video":
        report, extra = themed(p, data, progress)
    else:
        raise ValueError(f"Unknown video job {kind}")
    files = _finished(base, before, data)
    if kind == "themed_video":
        files += [f for f in extra if f not in files]
    message = str(report).replace(str(data) + "/", "")
    first = message.strip().splitlines()[0] if message.strip() else f"{LABELS[kind]} done"
    return {"message": f"{first} ({time.time() - started:.0f} s)", "report": message[:4000], "files": files}


def _num(v):
    return None if v in (None, "") else float(v)


def _int(v):
    return None if v in (None, "") else int(v)


def themed(p: dict, data: Path, progress) -> tuple[str, list[str]]:
    """A music video from real footage that fits the song: stock photos and clips (Pexels,
    Pixabay), photo-real AI pictures (ComfyUI) and/or your media, cut to the beat."""
    import random
    import shutil

    from .js import context
    from .js import images
    from .js.video import workflows as vw

    meta = context.library.get(str(p["song"])) or {}
    title = str(p.get("title") or meta.get("title") or "Music video")[:80]
    theme = str(p.get("theme") or "").strip() or str(meta.get("prompt") or "").strip() or title
    sources = p.get("sources") or ["stock"]
    aspect = p.get("aspect") or "16:9"
    count = max(4, min(60, int(p.get("count") or 16)))
    folder = media_root(data) / f"themed-{slug(title)}"
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    notes: list[str] = []
    got: list[tuple[stock.Item, Path]] = []
    n = 0
    if "media" in sources and p.get("media"):
        for f in sorted(media_path(str(p["media"]), data, True).iterdir()):
            if f.suffix.lower() in MEDIA_EXT - {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".txt"}:
                n += 1
                shutil.copyfile(f, folder / f"{n:02d}-mine-{f.name}")
    if "stock" in sources:
        progress(f"searching stock footage for “{theme[:60]}”")
        want = count - n if "ai" not in sources else max(0, round((count - n) * 0.7))
        items = stock.find(theme, aspect, want, float(p.get("video_share") or 0.6), notes) if want else []
        for i, it in enumerate(items):
            progress(f"downloading footage {i + 1} of {len(items)} ({it.credit})")
            try:
                n += 1
                got.append((it, stock.download(it, folder, n)))
            except Exception as e:  # noqa: BLE001
                notes.append(f"Skipped {it.page or it.url}: {e}")
        if not items and not notes:
            notes.append("No stock footage found for that theme: try simpler words (one idea per comma)")
    ai_prompts: list[str] = []
    if "ai" in sources:
        missing = max(0, count - n)
        size = {"16:9": "768x512", "9:16": "512x768"}.get(aspect, "512x512")
        qs = stock.queries(theme)
        for i in range(missing):
            q = qs[i % len(qs)]
            prompt = f"{q}, realistic photograph, natural light, 35mm lens, candid, high detail"
            progress(f"AI photo {i + 1} of {missing} on the graphics card")
            n += 1
            (folder / f"{n:02d}-ai-{slug(q)[:30]}.png").write_bytes(images.generate_png(prompt, size, None, random.randrange(1, 2**31)))
            ai_prompts.append(prompt)
    if n == 0:
        raise ValueError("No footage: " + ("; ".join(notes) if notes else "add stock keys, pick AI photos or a media folder"))
    progress(f"cutting {n} shots to the beat")
    report = vw.auto_edit(str(folder), str(p["song"]), aspect, p.get("pace") or "medium", title, None, _num(p.get("start")), _num(p.get("max_len")), bool(p.get("lyrics", True)))
    out = data / "outputs" / "themed-videos" / slug(title)
    out.mkdir(parents=True, exist_ok=True)
    (out / "credits.txt").write_text(stock.credits(got, ai_prompts))
    summary = f"Themed music video “{title}” from {len(got)} stock shots, {len(ai_prompts)} AI photos and {n - len(got) - len(ai_prompts)} of yours (theme: {theme[:80]})"
    if notes:
        summary += "\nNotes: " + " · ".join(notes[:5])
    return f"{summary}\n{report}", [str((out / 'credits.txt').relative_to(data))]
