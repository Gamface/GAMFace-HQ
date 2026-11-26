"""Stem splitting on the CPU with Hybrid Demucs (torchaudio's HDEMUCS_HIGH_MUSDB_PLUS): vocals,
drums, bass and other. The same model runs on the graphics card through ComfyUI when the
Mission Control stems node is installed there (see tools/comfyui/custom_nodes); this is the
fallback, and it gives the same result, only slower."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

SOURCES = ["vocals", "drums", "bass", "other"]
SEGMENT = 10.0  # seconds per chunk
OVERLAP = 0.1  # seconds the chunks overlap, cross-faded


def load_model():
    import torchaudio

    return torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS.get_model()


def separate(model, wav, sample_rate: int, progress: Callable[[float], None] | None = None, cancelled: Callable[[], bool] | None = None):
    """Runs the model over the song in overlapping chunks (the torchaudio tutorial's method)."""
    import torch
    from torchaudio.transforms import Fade

    batch, channels, length = wav.shape
    chunk = int(sample_rate * SEGMENT * (1 + OVERLAP))
    overlap = int(OVERLAP * sample_rate)
    fade = Fade(fade_in_len=0, fade_out_len=overlap, fade_shape="linear")
    start, end = 0, chunk
    out = torch.zeros(batch, len(model.sources), channels, length, device=wav.device)
    while start < length - overlap:
        if cancelled and cancelled():
            raise InterruptedError("Cancelled")
        piece = wav[:, :, start:end]
        with torch.no_grad():
            got = model.forward(piece)
        got = fade(got)
        out[:, :, :, start:end] += got
        if start == 0:
            fade.fade_in_len = overlap
            start += chunk - overlap
        else:
            start += chunk
        end += chunk
        if end >= length:
            fade.fade_out_len = 0
        if progress:
            progress(min(1.0, start / length))
    return out


def split(wav_path: Path, out_dir: Path, model=None, progress: Callable[[float], None] | None = None, cancelled: Callable[[], bool] | None = None) -> dict[str, Path]:
    """Splits a 44.1 kHz stereo WAV into stem WAVs in out_dir. Returns {stem: path}."""
    import numpy as np
    import soundfile as sf
    import torch

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    model = model or load_model()
    model.eval()
    data, sr = sf.read(str(wav_path), dtype="float32", always_2d=True)
    wav = torch.from_numpy(np.ascontiguousarray(data.T))
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    # The model expects normalised input; the scale is put back afterwards
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    sources = separate(model, ((wav - mean) / std)[None], sr, progress, cancelled)[0]
    sources = sources * std + mean
    out_dir.mkdir(parents=True, exist_ok=True)
    names = list(getattr(model, "sources", SOURCES))
    paths: dict[str, Path] = {}
    for name, audio in zip(names, sources):
        p = out_dir / f"{name}.wav"
        sf.write(str(p), audio.T.numpy().clip(-1, 1), sr, subtype="PCM_16")
        paths[name] = p
    return {n: paths[n] for n in SOURCES if n in paths}
