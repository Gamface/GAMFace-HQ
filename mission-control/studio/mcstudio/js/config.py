"""Paths for the video code: everything under the studio's data folder."""

from __future__ import annotations

import os
from pathlib import Path

from ..store import DATA


def _path(var: str, default: str) -> Path:
    # HQ: Jarvis Studio's ~/Videos/Jarvis becomes data/studio/outputs, so finished videos show on the Studio page
    if var == "JARVIS_VIDEO_OUT":
        return DATA / "outputs"
    return Path(os.environ.get(var, default)).expanduser()


STATE_DIR = DATA / "state"
OUT_ROOT = DATA / "outputs"


def out_dir(*parts: str) -> Path:
    d = OUT_ROOT.joinpath(*parts)
    d.mkdir(parents=True, exist_ok=True)
    return d


def safe_name(text: str) -> str:
    keep = "".join(c if c.isalnum() or c in " -_." else "_" for c in text).strip()
    return (keep or "song")[:80]
