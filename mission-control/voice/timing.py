"""Timing helpers for the voice service: sentences, word timings, beats, WAV files.

Pure Python + numpy, so they can be tested without the speech models.
"""

from __future__ import annotations

import difflib
import io
import re
import wave

import numpy as np

# ---------------------------------------------------------------- text


def split_sentences(text: str, max_chars: int = 280) -> list[str]:
    """Splits narration into sentences Kokoro can say in one go."""
    text = re.sub(r"[ \t]+", " ", text.strip())
    parts: list[str] = []
    for block in re.split(r"\n\s*\n|\n", text):
        block = block.strip()
        if not block:
            continue
        parts.extend(s.strip() for s in re.split(r"(?<=[.!?…])[\"')\]]*\s+", block) if s.strip())
    out: list[str] = []
    for s in parts:
        # Very long sentences are split at commas, then at spaces
        while len(s) > max_chars:
            cut = s.rfind(", ", 0, max_chars)
            if cut < max_chars // 3:
                cut = s.rfind(" ", 0, max_chars)
            if cut <= 0:
                cut = max_chars
            out.append(s[: cut + 1].strip())
            s = s[cut + 1 :].strip()
        if s:
            out.append(s)
    # A lone fragment ("Hi.") joins the next sentence so the pacing stays natural
    merged: list[str] = []
    for s in out:
        if merged and len(merged[-1]) < 12 and len(merged[-1]) + len(s) < max_chars:
            merged[-1] = f"{merged[-1]} {s}"
        else:
            merged.append(s)
    return merged


def script_words(text: str) -> list[str]:
    """The words of a script as they should appear in captions (punctuation kept)."""
    words: list[str] = []
    for tok in text.split():
        if not re.search(r"\w", tok) and words:
            words[-1] += tok if tok[0] in ",.;:!?…)\"'" else f" {tok}"
        elif re.search(r"\w", tok):
            words.append(tok)
    return words


def norm(word: str) -> str:
    return re.sub(r"[^\w]", "", word.lower().replace("’", "'").replace("'", ""))


# ---------------------------------------------------------------- word timings


def spread(spans: list[tuple[str, float, float]]) -> list[dict]:
    """Word timings from sentence timings alone, by length (used when Whisper can't help)."""
    out: list[dict] = []
    for sentence, start, end in spans:
        words = script_words(sentence)
        if not words:
            continue
        weights = np.array([len(norm(w)) + 2 for w in words], dtype=float)
        edges = start + (end - start) * np.concatenate([[0], np.cumsum(weights) / weights.sum()])
        for i, w in enumerate(words):
            out.append({"text": w, "start": round(float(edges[i]), 3), "end": round(float(edges[i + 1]), 3)})
    return out


def align(script: list[str], heard: list[tuple[str, float, float]], total: float) -> list[dict]:
    """Gives each script word a time, using the words Whisper heard as anchors.

    Captions show the script's own spelling; Whisper only supplies the timing. Words
    Whisper missed or heard differently get times between their neighbours.
    """
    if not script:
        return []
    times: list[tuple[float, float] | None] = [None] * len(script)
    if heard:
        a = [norm(w) for w in script]
        b = [norm(w) for w, _, _ in heard]
        for block in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_matching_blocks():
            for k in range(block.size):
                _, s, e = heard[block.b + k]
                times[block.a + k] = (float(s), float(e))
    # Fill the gaps between anchors in proportion to word length
    i = 0
    n = len(script)
    while i < n:
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < n and times[j] is None:
            j += 1
        left = times[i - 1][1] if i > 0 and times[i - 1] else 0.0
        right = times[j][0] if j < n and times[j] else max(total, left)
        if right < left:
            right = left
        weights = np.array([len(norm(script[k])) + 2 for k in range(i, j)], dtype=float)
        edges = left + (right - left) * np.concatenate([[0], np.cumsum(weights) / weights.sum()])
        for k in range(i, j):
            times[k] = (float(edges[k - i]), float(edges[k - i + 1]))
        i = j
    out = []
    last = 0.0
    for w, t in zip(script, times):
        s, e = t  # type: ignore[misc]
        s = max(s, last)
        e = max(e, s + 0.05)
        out.append({"text": w, "start": round(s, 3), "end": round(e, 3)})
        last = s
    return out


# ---------------------------------------------------------------- audio


def resample(x: np.ndarray, sr_from: int, sr_to: int) -> np.ndarray:
    if sr_from == sr_to or len(x) == 0:
        return x.astype(np.float32)
    n = int(round(len(x) * sr_to / sr_from))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def to_wav(samples: np.ndarray, sr: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def silence(seconds: float, sr: int) -> np.ndarray:
    return np.zeros(int(seconds * sr), dtype=np.float32)


# ---------------------------------------------------------------- beats


def onset_envelope(x: np.ndarray, sr: int, hop: int = 256, n_fft: int = 1024) -> tuple[np.ndarray, float]:
    """Spectral flux: how much new sound starts in each frame."""
    if len(x) < n_fft:
        return np.zeros(1), sr / hop
    frames = 1 + (len(x) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * np.hanning(n_fft), axis=1))
    logspec = np.log1p(100 * spec)
    flux = np.maximum(0, np.diff(logspec, axis=0)).sum(axis=1)
    flux = np.concatenate([[0], flux])
    # Remove the slow trend so only the hits stand out
    k = max(1, int(sr / hop * 0.5))
    trend = np.convolve(flux, np.ones(k) / k, mode="same")
    env = np.maximum(0, flux - trend)
    if env.max() > 0:
        env /= env.max()
    return env, sr / hop


def find_beats(x: np.ndarray, sr: int) -> dict:
    """Tempo and beat times of a music track (dynamic-programming beat tracker)."""
    env, fps = onset_envelope(x, sr)
    if len(env) < fps * 2 or env.max() == 0:
        return {"tempo": None, "beats": []}
    # Tempo: the autocorrelation peak between 60 and 200 BPM, gently preferring ~120
    ac = np.correlate(env, env, mode="full")[len(env) - 1 :]
    lags = np.arange(len(ac))
    lo, hi = int(fps * 60 / 200), int(fps * 60 / 60)
    hi = min(hi, len(ac) - 1)
    if hi <= lo:
        return {"tempo": None, "beats": []}
    cand = lags[lo : hi + 1]
    bpm = 60 * fps / cand
    prior = np.exp(-0.5 * (np.log2(bpm / 120) / 0.9) ** 2)
    score = ac[lo : hi + 1] * prior
    period = float(cand[int(np.argmax(score))])
    # Refine to a fractional lag with a parabola through the peak
    p = int(period)
    if lo < p < hi:
        y0, y1, y2 = score[p - lo - 1], score[p - lo], score[p - lo + 1]
        d = y0 - 2 * y1 + y2
        if d != 0:
            period = p + 0.5 * (y0 - y2) / d
    tempo = 60 * fps / period
    # Beats: best path through the onsets with steps close to one period
    n = len(env)
    best = env.copy()
    back = np.full(n, -1)
    tight = 100.0
    for t in range(n):
        a, b = int(t - 2 * period), int(t - period / 2)
        if b <= 0:
            continue
        a = max(0, a)
        prev = np.arange(a, b)
        cost = -tight * np.log((t - prev) / period) ** 2
        cand_scores = best[a:b] + cost
        j = int(np.argmax(cand_scores))
        if cand_scores[j] > 0:
            best[t] = env[t] + cand_scores[j]
            back[t] = prev[j]
    # Start from the strongest end point within the last period
    tail = max(0, n - int(period) - 1)
    t = tail + int(np.argmax(best[tail:]))
    beats = []
    while t >= 0:
        beats.append(t)
        t = back[t]
    beats.reverse()
    # A frame is timed by its middle, where the hit lands
    shift = 512 / sr
    return {"tempo": round(float(tempo), 1), "beats": [round(b / fps + shift, 3) for b in beats]}
