"""Captions: Whisper (HQ: in Mission Control's voice service) for speech, the library's
lyrics for songs, written as .srt (for players and Kdenlive) and styled .ass (burned into video)."""

import re
import subprocess
import tempfile
from pathlib import Path

from .common import FONT

Cue = tuple[float, float, str]


def transcribe(path: Path, language: str | None = None) -> list[dict]:
    """Whisper segments [{start, end, text, words:[{start,end,word}]}] for any audio/video.
    HQ: the voice service's /words gives timed words; they're grouped into segments at pauses."""
    from .. import context
    from ...karaoke import lines_from_words, transcribe_words

    if not context.voice_url:
        raise RuntimeError("Captions need Whisper in the voice service (VOICE_URL)")
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "speech.wav"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(path), "-vn", "-ac", "1",
                        "-ar", "16000", "-c:a", "pcm_s16le", str(wav)], check=True, timeout=900)
        words = transcribe_words(context.voice_url, wav)
    return [{"start": ln["start"], "end": ln["end"], "text": " ".join(w["text"] for w in ln["words"]),
             "words": [{"start": w["start"], "end": w["end"], "word": " " + w["text"]} for w in ln["words"]]}
            for ln in lines_from_words(words, gap=0.6, max_words=14)]


def cues_from_whisper(segments: list[dict], max_chars: int = 42, max_dur: float = 4.0,
                      offset: float = 0.0) -> list[Cue]:
    """Group words into readable cues."""
    cues, words = [], []
    for s in segments:
        ws = s.get("words") or [{"start": s["start"], "end": s["end"], "word": s["text"]}]
        words += [w for w in ws if w.get("word", "").strip() and not w["word"].strip().startswith("[")]
    cur, start, end = "", None, 0.0
    for w in words:
        # whisper.cpp splits words into sub-word tokens; a leading space starts a new word
        token = w["word"]
        nxt = (cur + token) if cur else token.strip()
        too_long = len(nxt.strip()) > max_chars or (start is not None and w["end"] - start > max_dur)
        if cur and too_long and token.startswith(" "):
            cues.append((start + offset, end + offset, cur.strip()))
            cur, start = token.strip(), w["start"]
        else:
            cur = nxt
            start = w["start"] if start is None else start
        end = w["end"]
        if cur.rstrip().endswith((".", "?", "!")) and len(cur) > max_chars * 0.5:
            cues.append((start + offset, end + offset, cur.strip()))
            cur, start = "", None
    if cur.strip():
        cues.append((start + offset, end + offset, cur.strip()))
    return cues


def parse_lrc(lrc: str) -> list[tuple[float, str]]:
    out = []
    for line in lrc.splitlines():
        stamps = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", line)
        text = re.sub(r"\[[^\]]*\]", "", line).strip()
        for m, s in stamps:
            out.append((int(m) * 60 + float(s), text))
    return sorted(out)


def cues_from_lrc(lrc: str, offset: float = 0.0, clip: tuple[float, float] | None = None,
                  max_dur: float = 6.0) -> list[Cue]:
    """Lyric cues, shifted by `offset`; `clip`=(start,end) keeps only that window (re-timed to 0)."""
    lines = parse_lrc(lrc)
    cues = []
    for i, (t, text) in enumerate(lines):
        if not text:
            continue
        end = lines[i + 1][0] if i + 1 < len(lines) else t + max_dur
        end = min(end, t + max_dur)
        if clip:
            if end <= clip[0] or t >= clip[1]:
                continue
            t, end = max(t, clip[0]) - clip[0], min(end, clip[1]) - clip[0]
        cues.append((t + offset, end + offset, text))
    return cues


def song_lyrics_lrc(job: dict) -> str | None:
    """Synced lyrics for a StemDeck song (looks them up online if needed)."""
    from .. import stemdeck as sd
    lyr = sd.lyrics(job) or sd.lookup_lyrics(job)
    if not isinstance(lyr, dict):
        return None
    synced = lyr.get("synced") or lyr.get("user_synced")
    if not synced and isinstance(lyr.get("lines"), list):
        synced = "\n".join(f"[{int(l['start'] // 60):02d}:{l['start'] % 60:05.2f}] {l.get('text', '')}"
                           for l in lyr["lines"] if isinstance(l, dict) and "start" in l)
    return synced or None


def _ts(t: float, sep: str = ",") -> str:
    t = max(0.0, t)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d}{sep}{int(round((s % 1) * 1000)) % 1000:03d}"


def write_srt(cues: list[Cue], dest: Path) -> Path:
    dest.write_text("\n".join(f"{i}\n{_ts(a)} --> {_ts(b)}\n{t}\n" for i, (a, b, t) in
                              enumerate(cues, 1)))
    return dest


def _ass_ts(t: float) -> str:
    t = max(0.0, t)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def write_ass(cues: list[Cue], dest: Path, size: tuple[int, int], style: str = "bottom") -> Path:
    """style: bottom (subtitles), lyrics (larger, lower third), pop (big centred, short-form)."""
    w, h = size
    base = min(w, h)
    if style == "pop":
        fs, align, margin, outline, upper = int(base * 0.085), 2, int(h * 0.2), 6, True
    elif style == "lyrics":
        fs, align, margin, outline, upper = int(base * 0.06), 2, int(h * 0.10), 4, False
    else:
        fs, align, margin, outline, upper = int(base * 0.05), 2, int(h * 0.06), 3, False
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{FONT},{fs},&H00FFFFFF,&H0040B7F4,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,{outline},2,{align},{int(w * 0.08)},{int(w * 0.08)},{margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for a, b, text in cues:
        t = text.replace("\n", " ").replace("{", "(").replace("}", ")")
        if upper:
            t = t.upper()
        fade = r"{\fad(120,120)}" if style != "pop" else r"{\fad(60,60)\t(0,120,\fscx108\fscy108)\t(120,220,\fscx100\fscy100)}"
        lines.append(f"Dialogue: 0,{_ass_ts(a)},{_ass_ts(b)},Default,,0,0,0,,{fade}{t}")
    dest.write_text(head + "\n".join(lines) + "\n")
    return dest


def pop_cues(segments: list[dict], offset: float = 0.0) -> list[Cue]:
    """Short-form style: 2-3 words at a time."""
    return cues_from_whisper(segments, max_chars=16, max_dur=1.2, offset=offset)


def cues_from_text(text: str, start: float, dur: float, max_chars: int = 42) -> list[Cue]:
    """Known text (e.g. a script paragraph) spread over [start, start+dur] by length."""
    words, chunks, cur = text.split(), [], ""
    for w in words:
        if cur and (len(cur) + 1 + len(w) > max_chars or cur.endswith((".", "?", "!"))):
            chunks.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        chunks.append(cur)
    total = sum(len(c) for c in chunks) or 1
    cues, t = [], start
    for c in chunks:
        d = dur * len(c) / total
        cues.append((t, t + d, c))
        t += d
    return cues
