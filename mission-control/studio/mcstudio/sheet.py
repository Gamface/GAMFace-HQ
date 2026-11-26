"""Sheet music: a stem to MIDI with basic-pitch (its ONNX model, no TensorFlow), then MIDI to a
PDF and MusicXML with MuseScore 3. An automatic transcription: treat it as a draft."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from .audio import AudioError, run

# General MIDI programs, so each part opens with a sensible sound and clef
PROGRAMS = {"vocals": 53, "bass": 33, "other": 0, "drums": 0, "piano": 0, "guitar": 25}
# basic-pitch's frequency range per part keeps out notes the part can't have
RANGES = {"bass": (30.0, 400.0), "vocals": (80.0, 1100.0)}


def musescore() -> str | None:
    return shutil.which("mscore3") or shutil.which("musescore3") or shutil.which("mscore")


def to_midi(wav: Path, midi: Path, part: str) -> int:
    """Transcribes one stem. Returns how many notes were found."""
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    lo, hi = RANGES.get(part, (None, None))
    _, midi_data, notes = predict(str(wav), ICASSP_2022_MODEL_PATH, minimum_frequency=lo, maximum_frequency=hi, minimum_note_length=100)
    for inst in midi_data.instruments:
        inst.program = PROGRAMS.get(part, 0)
        inst.name = part
    midi.parent.mkdir(parents=True, exist_ok=True)
    midi_data.write(str(midi))
    return len(notes)


def engrave(midi: Path, out_dir: Path) -> list[Path]:
    """MIDI → PDF and MusicXML. Returns the files made (none when MuseScore is missing)."""
    exe = musescore()
    if not exe:
        return []
    made = []
    # MuseScore is a desktop app: no screen in the container, so Qt draws offscreen
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    for ext in ("pdf", "musicxml"):
        dst = out_dir / f"{midi.stem}.{ext}"
        try:
            run([exe, "-o", str(dst), str(midi)], timeout=180)
        except AudioError:
            continue
        if dst.exists() and dst.stat().st_size > 0:
            made.append(dst)
    return made
