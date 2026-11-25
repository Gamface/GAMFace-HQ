"""speak(): narration from Kokoro in Mission Control's voice service (MOSS-TTS's voice cloning
isn't here). `voice` is a Kokoro voice name such as af_heart or bm_george."""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from . import context

DEFAULT_VOICE = os.environ.get("STUDIO_VOICE", "af_heart")


def speak_with_words(text: str, dest: Path, voice: str | None = None, speed: float = 1.0) -> list[dict]:
    """Speaks text into dest (WAV); returns the word timings the voice service measured."""
    if not context.voice_url:
        raise RuntimeError("Narration needs the voice service (VOICE_URL)")
    v = voice if voice and not str(voice).lower().endswith(".wav") and str(voice).lower() != "moss" else DEFAULT_VOICE
    body = json.dumps({"text": text, "voice": v, "speed": speed}).encode()
    req = urllib.request.Request(f"{context.voice_url.rstrip('/')}/speak", data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"The voice service couldn't speak with voice '{v}': {e.read().decode('utf-8', 'replace')[:200]}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError("The voice service isn't answering (VOICE_URL)") from e
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(base64.b64decode(out["audio"]))
    return out.get("words") or []


def speak(text: str, dest: Path, voice: str | None = None) -> Path:
    speak_with_words(text, dest, voice)
    return dest
