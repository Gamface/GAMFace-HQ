"""Audio helpers: ffmpeg for decoding, mixing and encoding, rubberband for speed and key."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

SR = 44100


class AudioError(RuntimeError):
    pass


def run(cmd: list[str], timeout: float = 900) -> str:
    """Runs a command; a failure raises AudioError with the end of its error output."""
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise AudioError(f"{Path(cmd[0]).name} took longer than {timeout:.0f} s") from e
    except FileNotFoundError as e:
        raise AudioError(f"{cmd[0]} isn't installed") from e
    if out.returncode != 0:
        tail = (out.stderr or out.stdout or "").strip().splitlines()[-3:]
        raise AudioError(f"{Path(cmd[0]).name} failed: {' / '.join(tail)[:400]}")
    return out.stdout


def ffmpeg(*args: str, timeout: float = 900) -> None:
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], timeout=timeout)


def duration(path: Path) -> float:
    try:
        out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], timeout=60)
    except AudioError as e:
        raise AudioError("That file has no audio ffmpeg can read") from e
    try:
        return round(float(json.loads(out)["format"]["duration"]), 2)
    except (KeyError, ValueError, json.JSONDecodeError) as e:
        raise AudioError("That file has no audio ffmpeg can read") from e


def to_wav(src: Path, dst: Path, sr: int = SR, channels: int = 2, start: float | None = None, end: float | None = None) -> Path:
    """Any audio (or video's audio) as 16-bit PCM WAV."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    cut = []
    if start is not None:
        cut += ["-ss", f"{start:.3f}"]
    if end is not None:
        cut += ["-to", f"{end:.3f}"]
    ffmpeg(*cut, "-i", str(src), "-vn", "-ac", str(channels), "-ar", str(sr), "-c:a", "pcm_s16le", str(dst))
    return dst


def mix(stems: dict[str, Path], gains: dict[str, float], dst: Path, start: float | None = None, end: float | None = None) -> Path:
    """Mixes stems with a gain each (0 = muted, 1 = as is); the mix is never normalised away."""
    parts = [(name, path) for name, path in stems.items() if gains.get(name, 1.0) > 0]
    if not parts:
        raise AudioError("Every part is muted")
    cut = []
    if start is not None:
        cut += ["-ss", f"{start:.3f}"]
    if end is not None:
        cut += ["-to", f"{end:.3f}"]
    inputs: list[str] = []
    for _, path in parts:
        inputs += [*cut, "-i", str(path)]
    chains = [f"[{i}:a]volume={max(0.0, min(4.0, gains.get(name, 1.0))):.3f}[a{i}]" for i, (name, _) in enumerate(parts)]
    graph = ";".join(chains) + ";" + "".join(f"[a{i}]" for i in range(len(parts))) + f"amix=inputs={len(parts)}:normalize=0:duration=longest[out]"
    dst.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg(*inputs, "-filter_complex", graph, "-map", "[out]", "-ar", str(SR), "-c:a", "pcm_s16le", str(dst))
    return dst


def stretch(src: Path, dst: Path, speed: float = 1.0, semitones: float = 0) -> Path:
    """Changes speed without changing key, and key without changing speed (rubberband)."""
    if abs(speed - 1.0) < 1e-3 and abs(semitones) < 1e-3:
        shutil.copyfile(src, dst)
        return dst
    if shutil.which("rubberband") is None:
        raise AudioError("rubberband isn't installed")
    run(["rubberband", "-q", "-T", f"{speed:.4f}", "-p", f"{semitones:.3f}", str(src), str(dst)])
    return dst


def to_mp3(src: Path, dst: Path, loudness: float | None = None) -> Path:
    """MP3 at 192 kbit/s; with `loudness`, normalised to that many LUFS (streaming uses -14)."""
    filt = ["-af", f"loudnorm=I={loudness}:TP=-1.0:LRA=11"] if loudness is not None else []
    ffmpeg("-i", str(src), *filt, "-ar", str(SR), "-c:a", "libmp3lame", "-b:a", "192k", str(dst))
    return dst


def speech_wav(src: Path, dst: Path) -> Path:
    """16 kHz mono 16-bit WAV, what Whisper in the voice service reads."""
    return to_wav(src, dst, sr=16000, channels=1)
