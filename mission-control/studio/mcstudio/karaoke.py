"""Karaoke lyrics: the vocal stem goes to Whisper in the voice service, and its word timings
become an .lrc file (line-timed, plus word-timed for players that show it)."""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from pathlib import Path


def stamp(t: float) -> str:
    m, s = divmod(max(0.0, t), 60)
    return f"{int(m):02d}:{s:05.2f}"


def lines_from_words(words: list[dict], gap: float = 0.8, max_words: int = 9) -> list[dict]:
    """Groups timed words into lines at pauses (or every max_words words)."""
    lines: list[dict] = []
    cur: list[dict] = []
    for w in words:
        text = str(w.get("text", "")).strip()
        if not text:
            continue
        if cur and (float(w["start"]) - float(cur[-1]["end"]) > gap or len(cur) >= max_words):
            lines.append({"start": float(cur[0]["start"]), "end": float(cur[-1]["end"]), "words": cur})
            cur = []
        cur.append({"text": text, "start": float(w["start"]), "end": float(w["end"])})
    if cur:
        lines.append({"start": float(cur[0]["start"]), "end": float(cur[-1]["end"]), "words": cur})
    return lines


def lrc(lines: list[dict], title: str, offset: float = 0.0, word_times: bool = False) -> str:
    """An .lrc file. `offset` shifts every time (a practice clip that starts mid-song)."""
    out = [f"[ti:{title}]", "[re:Mission Control Studio]"]
    for ln in lines:
        start = ln["start"] - offset
        if start < 0:
            continue
        if word_times:
            text = " ".join(f"<{stamp(w['start'] - offset)}>{w['text']}" for w in ln["words"])
        else:
            text = " ".join(w["text"] for w in ln["words"])
        out.append(f"[{stamp(start)}]{text}")
    return "\n".join(out) + "\n"


def transcribe_words(voice_url: str, speech_wav: Path, timeout: float = 900) -> list[dict]:
    """Word timings from the voice service's Whisper (/words)."""
    body = json.dumps({"audio": base64.b64encode(speech_wav.read_bytes()).decode()}).encode()
    req = urllib.request.Request(f"{voice_url.rstrip('/')}/words", data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"The voice service couldn't transcribe the vocals: {e.read().decode('utf-8', 'replace')[:300]}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError("The voice service isn't answering, so there are no lyrics (VOICE_URL)") from e
    return out.get("words", [])
