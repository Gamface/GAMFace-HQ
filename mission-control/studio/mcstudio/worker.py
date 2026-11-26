"""The job runner: one job at a time (stem splitting and songs use the graphics card or every
CPU core, so two at once would only slow both down)."""

from __future__ import annotations

import os
import random
import shutil
import tempfile
import threading
import time
import traceback
from pathlib import Path

from . import audio, daw, karaoke, separate, sheet, videojobs
from .js import context as js_context
from .comfy import STEM_NODE, STEMS, Comfy, ComfyError, audio_files, song_workflow, split_workflow
from .store import DATA, Jobs, Library, slug

MUSIC_KINDS = ("split", "song", "practice", "karaoke", "sheet", "daw")
KINDS = MUSIC_KINDS + videojobs.VIDEO_KINDS


class Worker:
    def __init__(self, library: Library, jobs: Jobs, comfy: Comfy | None, voice_url: str | None, data: Path | None = None, cpu_model=None):
        self.library = library
        self.jobs = jobs
        self.comfy = comfy
        self.voice_url = voice_url
        self.data = data or DATA
        self.cpu_model = cpu_model  # tests pass a small model; normally loaded on first CPU split
        # Set when a GPU split crashed ComfyUI; stems then stay on the CPU until a restart
        self.gpu_stems_failed: str | None = None if os.environ.get("STUDIO_GPU_STEMS", "on") != "off" else "turned off (STUDIO_GPU_STEMS=off)"
        # The video workflows reach the library, ComfyUI and the voice service through here
        js_context.library, js_context.comfy, js_context.voice_url = library, comfy, voice_url
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def loop(self) -> None:
        while True:
            job = self.jobs.next_queued()
            if job is None:
                self.wake.wait(5)
                self.wake.clear()
                continue
            self.run(job)

    def run(self, job: dict) -> None:
        self.jobs.update(job, status="running", startedAt=int(time.time() * 1000), progress="starting")
        try:
            if job["type"] in videojobs.VIDEO_KINDS:
                result = videojobs.run(job["type"], job["params"], self.data, lambda t: self.progress(job, t))
            else:
                result = getattr(self, f"do_{job['type']}")(job, **job["params"])
            self.jobs.update(job, status="done", progress="", result=result, finishedAt=int(time.time() * 1000))
        except InterruptedError:
            self.jobs.update(job, status="cancelled", progress="", finishedAt=int(time.time() * 1000))
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self.jobs.update(job, status="failed", progress="", error=str(e)[:600], finishedAt=int(time.time() * 1000))
        finally:
            self.jobs.cancelled.discard(job["id"])

    # --- helpers -------------------------------------------------------------------------

    def progress(self, job: dict, text: str) -> None:
        self.jobs.update(job, progress=text)

    def cancelled(self, job: dict):
        return lambda: job["id"] in self.jobs.cancelled

    def out_dir(self, kind: str, title: str, job: dict) -> Path:
        d = self.data / "outputs" / kind / f"{slug(title)}-{job['id'][:6]}"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def rel(self, *paths: Path) -> list[str]:
        return [str(p.relative_to(self.data)) for p in paths]

    def song(self, sid: str) -> dict:
        meta = self.library.get(sid)
        if meta is None:
            raise ValueError("That song isn't in the library any more")
        return meta

    def ready_stems(self, sid: str) -> dict[str, Path]:
        stems = self.library.stems(sid)
        if not stems:
            raise ValueError("Split the song into stems first")
        return stems

    def gpu_stems(self) -> bool:
        """The ComfyUI stems node is installed, and hasn't crashed ComfyUI in this run."""
        return not self.gpu_stems_failed and bool(self.comfy and self.comfy.node_info(STEM_NODE))

    # --- jobs ----------------------------------------------------------------------------

    def split_on_gpu(self, job: dict, song: str, src: Path, out: Path) -> None:
        self.progress(job, "splitting on the graphics card (ComfyUI)")
        name = self.comfy.upload(src, "mission-control")
        outputs = self.comfy.run(split_workflow(name, f"mission-control/stems/{song}"), timeout=3600, cancelled=self.cancelled(job), progress=lambda t: self.progress(job, t))
        files = audio_files(outputs)
        with tempfile.TemporaryDirectory() as tmp:
            for i, stem in enumerate(STEMS):
                got = files.get(str(10 + i))
                if not got:
                    raise ComfyError(f"ComfyUI made no {stem} stem")
                raw = self.comfy.fetch(got[0], Path(tmp) / f"{stem}.flac")
                audio.to_wav(raw, out / f"{stem}.wav")

    def split_on_cpu(self, job: dict, src: Path, out: Path, why: str) -> None:
        self.progress(job, f"splitting on the CPU ({why})")
        if self.cpu_model is None:
            self.cpu_model = separate.load_model()
        separate.split(src, out, self.cpu_model, progress=lambda f: self.progress(job, f"splitting on the CPU ({why}): {int(f * 100)}%"), cancelled=self.cancelled(job))

    def do_split(self, job: dict, song: str) -> dict:
        meta = self.song(song)
        src = self.library.original(song)
        out = self.library.dir(song) / "stems"
        self.library.update(song, status="splitting", error=None)
        note = ""
        try:
            device = "cpu"
            if self.gpu_stems():
                try:
                    self.split_on_gpu(job, song, src, out)
                    device = "gpu"
                except ComfyError as e:
                    # A crash in ComfyUI (often the AMD driver) shouldn't lose the split: finish it on
                    # the CPU, and don't send stems to the graphics card again until the studio restarts
                    self.gpu_stems_failed = str(e)[:300]
                    note = f" The graphics card failed ({str(e)[:160]}), so it was split on the CPU; GPU stems are off until the studio restarts."
                    self.split_on_cpu(job, src, out, "the graphics card failed")
            else:
                self.split_on_cpu(job, src, out, "GPU stems are off" if self.gpu_stems_failed else "install the stems node in ComfyUI for the graphics card")
        except BaseException as e:
            self.library.update(song, status="failed" if not isinstance(e, InterruptedError) else "new", error=str(e)[:400])
            raise
        stems = [s for s in STEMS if (out / f"{s}.wav").exists()]
        self.library.update(song, status="ready", stems=stems, splitBy=device, error=None)
        return {"message": f"Split “{meta['title']}” into {', '.join(stems)} on the {'graphics card' if device == 'gpu' else 'CPU'}.{note}", "song": song, "files": self.rel(*(out / f"{s}.wav" for s in stems))}

    def do_song(self, job: dict, prompt: str, title: str = "", lyrics: str = "", seconds: float = 60, bpm: int = 100, key: str = "C major", timesig: str = "4", language: str = "en", seed: int | None = None, split: bool = True) -> dict:
        if not self.comfy:
            raise ValueError("Songs are made by ACE-Step in ComfyUI: set COMFY_URL for the studio service")
        models = self.comfy.ace_models()
        if not models:
            if not self.comfy.running():
                raise ComfyError("ComfyUI isn't running on the PC")
            raise ValueError("ACE-Step 1.5 isn't in ComfyUI yet: open ComfyUI (http://127.0.0.1:8188), pick Templates > Audio > ACE-Step 1.5 and let it download the models (either the all-in-one checkpoint or the split files), then try again.")
        seed = int(seed) if seed is not None else random.randrange(1, 2**31)
        seconds = max(10.0, min(600.0, float(seconds)))
        title = title.strip() or prompt.strip()[:60] or "New song"
        self.progress(job, "writing the song on the graphics card (ACE-Step 1.5)")
        outputs = self.comfy.run(
            song_workflow(models, prompt, lyrics, seconds, int(bpm), key, str(timesig), language, seed, f"mission-control/songs/{slug(title)}"),
            timeout=3600,
            cancelled=self.cancelled(job),
            progress=lambda t: self.progress(job, f"writing the song: {t}"),
        )
        files = next(iter(audio_files(outputs).values()), None)
        if not files:
            raise ComfyError("ACE-Step finished but saved no audio")
        meta = self.library.create(title, "ace-step", prompt=prompt, lyrics=lyrics, bpm=int(bpm), key=key, seed=seed, seconds=seconds)
        with tempfile.TemporaryDirectory() as tmp:
            raw = self.comfy.fetch(files[0], Path(tmp) / "song.flac")
            audio.to_wav(raw, self.library.original(meta["id"]))
        dur = audio.duration(self.library.original(meta["id"]))
        self.library.update(meta["id"], duration=dur)
        out = self.out_dir("songs", title, job)
        mp3 = audio.to_mp3(self.library.original(meta["id"]), out / f"{slug(title)}.mp3", loudness=-14)
        (out / f"{slug(title)}.txt").write_text(f"{title}\n\nStyle: {prompt}\nBPM: {bpm}  Key: {key}  Time: {timesig}/4  Seed: {seed}  Model: {models['label']}\n\n{lyrics or '[Instrumental]'}\n")
        result = {"message": f"Made “{title}” ({dur:.0f} s)", "song": meta["id"], "files": self.rel(mp3, out / f"{slug(title)}.txt")}
        if split:
            self.jobs.add("split", {"song": meta["id"]}, f"Split {title}")
            self.wake.set()
        return result

    def do_practice(self, job: dict, song: str, gains: dict | None = None, speed: float = 1.0, semitones: float = 0, start: float | None = None, end: float | None = None) -> dict:
        meta = self.song(song)
        stems = self.ready_stems(song)
        gains = {k: float(v) for k, v in (gains or {}).items()}
        speed = max(0.5, min(1.5, float(speed)))
        semitones = max(-12, min(12, float(semitones)))
        muted = [n for n in stems if gains.get(n, 1.0) == 0]
        label = " ".join(x for x in [f"no {'+'.join(muted)}" if muted else "", f"{int(speed * 100)}%" if speed != 1 else "", f"{semitones:+g} st" if semitones else ""] if x) or "mix"
        out = self.out_dir("practice", f"{meta['title']} {label}", job)
        with tempfile.TemporaryDirectory() as tmp:
            self.progress(job, "mixing the stems")
            mixed = audio.mix(stems, gains, Path(tmp) / "mix.wav", start, end)
            self.progress(job, "changing speed and key" if (speed != 1 or semitones) else "encoding")
            done = audio.stretch(mixed, Path(tmp) / "practice.wav", speed, semitones)
            wav = out / f"{slug(meta['title'])}-{slug(label)}.wav"
            shutil.copyfile(done, wav)
            mp3 = audio.to_mp3(done, wav.with_suffix(".mp3"))
        return {"message": f"Practice track for “{meta['title']}” ({label})", "song": song, "files": self.rel(mp3, wav)}

    def do_karaoke(self, job: dict, song: str, semitones: float = 0, lyrics: bool = True, keep_backing_vocals: bool = False) -> dict:
        meta = self.song(song)
        stems = self.ready_stems(song)
        out = self.out_dir("karaoke", meta["title"], job)
        name = slug(meta["title"])
        files: list[Path] = []
        with tempfile.TemporaryDirectory() as tmp:
            self.progress(job, "making the backing track")
            backing = audio.mix(stems, {"vocals": 0.25 if keep_backing_vocals else 0.0}, Path(tmp) / "backing.wav")
            shifted = audio.stretch(backing, Path(tmp) / "shifted.wav", 1.0, max(-12, min(12, float(semitones))))
            files.append(audio.to_mp3(shifted, out / f"{name}-karaoke.mp3"))
        message = f"Karaoke backing for “{meta['title']}”"
        if lyrics and "vocals" in stems:
            if not self.voice_url:
                message += " (no lyrics: the voice service isn't set up)"
            else:
                self.progress(job, "listening to the vocals for the lyrics (Whisper)")
                words = meta.get("words")
                if not words:
                    with tempfile.TemporaryDirectory() as tmp:
                        words = karaoke.transcribe_words(self.voice_url, audio.speech_wav(stems["vocals"], Path(tmp) / "vocals16k.wav"))
                    self.library.update(song, words=words)
                lines = karaoke.lines_from_words(words)
                if lines:
                    (out / f"{name}.lrc").write_text(karaoke.lrc(lines, meta["title"]))
                    (out / f"{name}-words.lrc").write_text(karaoke.lrc(lines, meta["title"], word_times=True))
                    (out / f"{name}-lyrics.txt").write_text("\n".join(" ".join(w["text"] for w in ln["words"]) for ln in lines) + "\n")
                    files += [out / f"{name}.lrc", out / f"{name}-words.lrc", out / f"{name}-lyrics.txt"]
                    message += f" with {len(lines)} lines of timed lyrics"
                else:
                    message += " (Whisper heard no words in the vocals)"
        return {"message": message, "song": song, "files": self.rel(*files)}

    def do_sheet(self, job: dict, song: str, parts: list[str] | None = None) -> dict:
        meta = self.song(song)
        stems = self.ready_stems(song)
        parts = [p for p in (parts or ["vocals", "bass"]) if p in stems and p != "drums"]
        if not parts:
            raise ValueError("Pick at least one part with notes (vocals, bass or other)")
        out = self.out_dir("sheet", meta["title"], job)
        files: list[Path] = []
        counts = []
        for p in parts:
            self.progress(job, f"writing out the {p} (basic-pitch)")
            midi = out / f"{slug(meta['title'])}-{p}.mid"
            n = sheet.to_midi(stems[p], midi, p)
            counts.append(f"{p}: {n} notes")
            files.append(midi)
            self.progress(job, f"engraving the {p} (MuseScore)")
            files += sheet.engrave(midi, out)
        note = "" if sheet.musescore() else " (MIDI only: MuseScore isn't installed)"
        return {"message": f"Sheet music for “{meta['title']}” ({'; '.join(counts)}){note}. An automatic transcription: treat it as a draft.", "song": song, "files": self.rel(*files)}

    def do_daw(self, job: dict, song: str) -> dict:
        meta = self.song(song)
        stems = self.ready_stems(song)
        out = self.out_dir("daw", meta["title"], job)
        self.progress(job, "packing the stems")
        lengths = {n: audio.duration(p) for n, p in stems.items()}
        z = daw.export(meta["title"], slug(meta["title"]), stems, lengths, out / f"{slug(meta['title'])}-stems.zip", bpm=meta.get("bpm"))
        return {"message": f"Stems of “{meta['title']}” for Audacity, Ardour, REAPER or any DAW", "song": song, "files": self.rel(z)}


def job_title(kind: str, params: dict, library: Library) -> str:
    song = library.get(str(params.get("song", ""))) if params.get("song") else None
    name = str(params.get("title") or "") or (song["title"] if song else str(params.get("prompt") or "")[:60])
    labels = {"split": "Split", "song": "New song", "practice": "Practice", "karaoke": "Karaoke", "sheet": "Sheet music", "daw": "DAW stems", **videojobs.LABELS}
    return labels[kind] + (f": {name[:60]}" if name else "")


def check_params(kind: str, p: dict, library: Library) -> str | None:
    """What's wrong with a job request, or None."""
    if kind not in KINDS:
        return f"Unknown job type (one of {', '.join(KINDS)})"
    if kind in videojobs.VIDEO_KINDS:
        return videojobs.check(kind, p, library)
    if kind == "song":
        if not str(p.get("prompt", "")).strip():
            return "Describe the song (style, instruments, mood)"
        if len(str(p.get("lyrics", ""))) > 4000:
            return "The lyrics are too long (4000 characters at most)"
        return None
    song = library.get(str(p.get("song", "")))
    if song is None:
        return "Pick a song from the library"
    if kind != "split" and song.get("status") != "ready":
        return "That song hasn't been split into stems yet"
    return None


def save_upload(library: Library, title: str, data: bytes, filename: str) -> dict:
    """A new library song from uploaded audio (any format ffmpeg reads, video included)."""
    suffix = Path(filename).suffix[:8] or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        raw = Path(f.name)
    try:
        dur = audio.duration(raw)
        if dur > 20 * 60:
            raise ValueError("That's over 20 minutes; split a shorter piece")
        meta = library.create(title or Path(filename).stem or "Upload", "upload", filename=filename[:200], duration=dur)
        try:
            audio.to_wav(raw, library.original(meta["id"]))
        except Exception:
            library.delete(meta["id"])
            raise
        return meta
    finally:
        raw.unlink(missing_ok=True)


