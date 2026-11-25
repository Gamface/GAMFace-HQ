"""Stems for a DAW: one ZIP with the stems (all starting at 0:00, so they line up), any MIDI,
a REAPER project and notes for Audacity and Ardour."""

from __future__ import annotations

import zipfile
from pathlib import Path

GUIDE = """{title}: stems from Mission Control Studio

Every stem starts at 0:00 and has the same length, so they line up wherever you put them.

Audacity:  File > Import > Audio..., select every file in stems/ at once.
Ardour:    Session > Import, select the stems, "Add files as new tracks", "at session start".
REAPER:    open {title_file}.rpp (the stems are already on their tracks).
Any DAW:   drag the stems onto separate tracks at the very start.
{midi}"""


def rpp(title: str, stems: list[tuple[str, float]], bpm: float | None = None) -> str:
    """A minimal REAPER project with one track per stem."""
    tracks = []
    for name, length in stems:
        tracks.append(
            f"""  <TRACK
    NAME "{name}"
    <ITEM
      POSITION 0
      LENGTH {length:.3f}
      NAME "{name}"
      <SOURCE WAVE
        FILE "stems/{name}.wav"
      >
    >
  >"""
        )
    tempo = f"  TEMPO {bpm:.2f} 4 4\n" if bpm else ""
    return f'<REAPER_PROJECT 0.1 "6.0" 0\n  TITLE "{title}"\n{tempo}' + "\n".join(tracks) + "\n>\n"


def export(title: str, slug: str, stems: dict[str, Path], lengths: dict[str, float], dst: Path, midi: list[Path] | None = None, bpm: float | None = None) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    midi = midi or []
    with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, path in stems.items():
            z.write(path, f"stems/{name}.wav")
        for m in midi:
            z.write(m, f"midi/{m.name}")
        z.writestr(f"{slug}.rpp", rpp(title, [(n, lengths.get(n, 0.0)) for n in stems], bpm))
        z.writestr(
            "README.txt",
            GUIDE.format(title=title, title_file=slug, midi="MIDI:      midi/ has the parts as notes, for a piano roll or MuseScore.\n" if midi else ""),
        )
    return dst
