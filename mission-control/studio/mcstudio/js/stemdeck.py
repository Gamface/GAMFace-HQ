"""StemDeck's functions, answered from the studio library. A "job" is StemDeck's word for a
split song: here it's the library song's meta with job_id and stems filled in."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from .. import audio
from .. import karaoke
from . import context


class StemDeckError(RuntimeError):
    pass


def _job(meta: dict) -> dict:
    return {**meta, "job_id": meta["id"], "stems": [{"name": s} for s in meta.get("stems", [])]}


def find(query: str) -> dict:
    lib = context.library
    q = str(query).strip()
    meta = lib.get(q) if len(q) == 12 else None
    if meta is None:
        matches = [m for m in lib.list() if m["title"].lower() == q.lower()] or [m for m in lib.list() if q.lower() in m["title"].lower()]
        meta = matches[0] if matches else None
    if meta is None:
        raise StemDeckError(f"No song called '{query}' in the studio library")
    if meta.get("status") != "ready":
        raise StemDeckError(f"“{meta['title']}” hasn't been split into stems yet")
    return _job(meta)


def ensure_song(song: str) -> dict:
    return find(song)


def stem_names(job: dict) -> list[str]:
    return [s["name"] for s in job.get("stems", [])]


def _paths(job: dict) -> dict[str, Path]:
    return context.library.stems(job["job_id"])


def download_stems(job: dict, dest_dir: Path, names: list[str] | None = None) -> dict[str, Path]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = {}
    for name, p in _paths(job).items():
        if names is None or name in names:
            out[name] = Path(shutil.copyfile(p, dest_dir / f"{name}.wav"))
    return out


def render_mix(job: dict, dest: Path, gains: dict[str, float], semitones: int = 0, start: float | None = None, end: float | None = None, click: bool = False, count_in: int = 0) -> Path:
    stems = _paths(job)
    if not any(gains.get(s, 1.0) > 0 for s in stems):
        raise StemDeckError("That would mute every part.")
    with tempfile.TemporaryDirectory() as tmp:
        mixed = audio.mix(stems, gains, Path(tmp) / "mix.wav", start, end)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.suffix.lower() == ".wav":
            audio.stretch(mixed, dest, 1.0, semitones)
        else:
            shifted = audio.stretch(mixed, Path(tmp) / "shifted.wav", 1.0, semitones)
            audio.ffmpeg("-i", str(shifted), str(dest))
    return dest


def sections(job: dict) -> list[dict]:
    return []


def section_bounds(job: dict, name: str) -> tuple[float, float]:
    # HQ: the studio doesn't detect song sections (StemDeck's experimental feature); use start and end
    raise StemDeckError(f"Song sections (like '{name}') aren't detected in Mission Control: give a start and end in seconds instead")


def lyrics(job: dict) -> dict | None:
    """Timed lyrics Whisper heard in the vocals (kept with the song after karaoke)."""
    meta = context.library.get(job["job_id"]) or {}
    words = meta.get("words")
    if not words:
        return None
    return {"lines": [{"start": ln["start"], "text": " ".join(w["text"] for w in ln["words"])} for ln in karaoke.lines_from_words(words)]}


def lookup_lyrics(job: dict) -> dict | None:
    """Listens to the vocals once (Whisper in the voice service) and keeps the words with the song."""
    stems = _paths(job)
    if "vocals" not in stems or not context.voice_url:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        words = karaoke.transcribe_words(context.voice_url, audio.speech_wav(stems["vocals"], Path(tmp) / "v.wav"))
    context.library.update(job["job_id"], words=words)
    return lyrics(job)
