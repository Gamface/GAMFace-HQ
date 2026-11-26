"""Tempo and key of a track (librosa), so vocals added to an instrumental sit on its beat and in
its key. An estimate: half or double tempo and relative major/minor mix-ups happen."""

from __future__ import annotations

from pathlib import Path

NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Krumhansl-Schmuckler key profiles
MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def tempo_key(path: Path, max_seconds: float = 120) -> dict:
    """{"bpm": int, "key": "A minor"}; either is missing when it can't be worked out."""
    import numpy as np

    try:
        import librosa
    except ImportError:
        return {}
    y, sr = librosa.load(str(path), sr=22050, mono=True, duration=max_seconds)
    if y.size < sr:
        return {}
    out: dict = {}
    try:
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])
        # Keep it in the range ACE-Step and most songs use
        while bpm and bpm < 60:
            bpm *= 2
        while bpm > 190:
            bpm /= 2
        if bpm:
            out["bpm"] = int(round(bpm))
    except Exception:  # noqa: BLE001
        pass
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
        best = (-2.0, "C major")
        for i in range(12):
            for profile, quality in ((MAJOR, "major"), (MINOR, "minor")):
                r = float(np.corrcoef(chroma, np.roll(profile, i))[0, 1])
                if r > best[0]:
                    best = (r, f"{NOTES[i]} {quality}")
        out["key"] = best[1]
    except Exception:  # noqa: BLE001
        pass
    return out
