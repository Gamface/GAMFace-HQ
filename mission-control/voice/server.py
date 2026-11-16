"""Mission Control voice service: Kokoro voiceovers, Whisper word timings, music beats.

  GET  /health                         -> { ok, ready, voices, whisper, error? }
  POST /speak  { text, voice?, speed? } -> { audio (WAV, base64), seconds, words, voice }
  POST /words  { audio (base64), text? } -> { words, seconds, text }
  POST /beats  { audio (base64) }        -> { tempo, beats, seconds }

Words are [{ text, start, end }] in seconds. For /speak, Whisper listens to the
voiceover and the script's own words get its timings, so captions match what was
written. Runs on the CPU, with no internet (the models are baked into the image).
"""

from __future__ import annotations

import base64
import json
import os
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from timing import align, find_beats, resample, script_words, silence, split_sentences, spread, to_wav

PORT = int(os.environ.get("PORT", "3030"))
MODELS = os.environ.get("VOICE_MODELS_DIR", "/models")
WHISPER_MODEL = os.environ.get("VOICE_WHISPER_MODEL", "base.en")
DEFAULT_VOICE = os.environ.get("VOICE_DEFAULT", "af_heart")
MAX_TEXT = 6000
MAX_AUDIO = 60 * 1024 * 1024
GAP = 0.18  # seconds of silence between sentences

# Kokoro picks its pronunciation from the voice's first letter
LANGS = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "p": "pt-br", "j": "ja", "z": "cmn"}

state: dict = {"kokoro": None, "whisper": None, "voices": [], "error": None, "ready": False}
lock = threading.Lock()


def load() -> None:
    try:
        from kokoro_onnx import Kokoro

        k = Kokoro(os.path.join(MODELS, "kokoro-v1.0.onnx"), os.path.join(MODELS, "voices-v1.0.bin"))
        voices = k.get_voices() if hasattr(k, "get_voices") else list(getattr(k, "voices", {}).keys())
        state["kokoro"] = k
        state["voices"] = sorted(voices)
    except Exception as e:  # noqa: BLE001
        state["error"] = f"Kokoro didn't load: {e}"
        traceback.print_exc()
    try:
        from faster_whisper import WhisperModel

        state["whisper"] = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", download_root=os.path.join(MODELS, "whisper"), local_files_only=True)
    except Exception as e:  # noqa: BLE001
        state["error"] = (state["error"] + "; " if state["error"] else "") + f"Whisper didn't load: {e}"
        traceback.print_exc()
    state["ready"] = True
    print(f"Voice service ready: {len(state['voices'])} voices, Whisper {WHISPER_MODEL if state['whisper'] else 'off'}", flush=True)


def english_only() -> bool:
    return WHISPER_MODEL.endswith(".en")


def hear(samples16k: np.ndarray, prompt: str | None = None, language: str | None = None) -> tuple[list[tuple[str, float, float]], str]:
    """Words Whisper hears, with times. Empty when Whisper isn't available."""
    model = state["whisper"]
    if model is None:
        return [], ""
    kwargs = {"word_timestamps": True, "vad_filter": False, "beam_size": 5}
    if prompt:
        kwargs["initial_prompt"] = prompt[:800]
    if language and not english_only():
        kwargs["language"] = language
    with lock:
        segments, _ = model.transcribe(samples16k, **kwargs)
        words, text = [], []
        for seg in segments:
            text.append(seg.text.strip())
            for w in seg.words or []:
                words.append((w.word.strip(), float(w.start), float(w.end)))
    return words, " ".join(text).strip()


def speak(text: str, voice: str, speed: float) -> dict:
    k = state["kokoro"]
    if k is None:
        raise RuntimeError(state["error"] or "Kokoro isn't loaded yet")
    if state["voices"] and voice not in state["voices"]:
        voice = DEFAULT_VOICE if DEFAULT_VOICE in state["voices"] else state["voices"][0]
    lang = LANGS.get(voice[:1], "en-us")
    pieces, spans, t, sr = [], [], 0.0, 24000
    for sentence in split_sentences(text):
        with lock:
            samples, sr = k.create(sentence, voice=voice, speed=speed, lang=lang)
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        dur = len(samples) / sr
        spans.append((sentence, t, t + dur))
        pieces.extend([samples, silence(GAP, sr)])
        t += dur + GAP
    if not pieces:
        raise ValueError("Nothing to say")
    audio = np.concatenate(pieces[:-1])
    seconds = len(audio) / sr
    words = []
    if lang.startswith("en") or not english_only():
        heard, _ = hear(resample(audio, sr, 16000), prompt=text, language=lang.split("-")[0])
        if heard:
            words = align(script_words(text), heard, seconds)
    if not words:
        words = spread(spans)
    return {"audio": base64.b64encode(to_wav(audio, sr)).decode(), "seconds": round(seconds, 3), "words": words, "voice": voice}


def decode(b64: str) -> np.ndarray:
    raw = base64.b64decode(b64)
    if len(raw) > MAX_AUDIO:
        raise ValueError("The audio is too large")
    try:
        from faster_whisper.audio import decode_audio
    except ImportError:  # older layout
        from faster_whisper import decode_audio  # type: ignore[no-redef]
    with tempfile.NamedTemporaryFile(suffix=".audio") as f:
        f.write(raw)
        f.flush()
        return decode_audio(f.name, sampling_rate=16000)


class Handler(BaseHTTPRequestHandler):
    server_version = "mc-voice"

    def log_message(self, fmt, *args):  # quieter logs
        if "/health" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, {"ok": True, "ready": state["ready"], "voices": state["voices"], "whisper": WHISPER_MODEL if state["whisper"] else None, "error": state["error"]})
        self.send(404, {"error": "Not found"})

    def do_POST(self):
        size = int(self.headers.get("Content-Length") or 0)
        if size > MAX_AUDIO * 1.4:
            return self.send(413, {"error": "Request too large"})
        try:
            body = json.loads(self.rfile.read(size) or b"{}")
        except json.JSONDecodeError:
            return self.send(400, {"error": "Invalid JSON"})
        if not state["ready"]:
            return self.send(503, {"error": "The voice models are still loading"})
        started = time.time()
        try:
            if self.path == "/speak":
                text = str(body.get("text") or "").strip()
                if not text:
                    return self.send(400, {"error": "No text"})
                if len(text) > MAX_TEXT:
                    return self.send(400, {"error": f"The narration is too long (at most {MAX_TEXT} characters)"})
                speed = min(1.6, max(0.6, float(body.get("speed") or 1.0)))
                out = speak(text, str(body.get("voice") or DEFAULT_VOICE), speed)
            elif self.path == "/words":
                if state["whisper"] is None:
                    return self.send(503, {"error": state["error"] or "Whisper isn't loaded"})
                samples = decode(str(body.get("audio") or ""))
                seconds = len(samples) / 16000
                prompt = str(body.get("text") or "").strip() or None
                heard, text = hear(samples, prompt=prompt)
                words = align(script_words(prompt), heard, seconds) if prompt else [{"text": w, "start": round(s, 3), "end": round(e, 3)} for w, s, e in heard]
                out = {"words": words, "seconds": round(seconds, 3), "text": prompt or text}
            elif self.path == "/beats":
                samples = decode(str(body.get("audio") or ""))
                out = {**find_beats(samples, 16000), "seconds": round(len(samples) / 16000, 3)}
            else:
                return self.send(404, {"error": "Not found"})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})
        print(f"{self.path} done in {time.time() - started:.1f}s", flush=True)
        self.send(200, out)


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    print(f"Voice service on port {PORT} (loading models…)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
