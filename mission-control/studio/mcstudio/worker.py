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

from . import analyze, audio, daw, karaoke, pictures, separate, sheet, videojobs
from .js import context as js_context
from .comfy import STEM_NODE, STEMS, UPSCALE_DOWNLOAD, Comfy, ComfyError, audio_files, edit_workflow, image_files, song_workflow, split_workflow, upscale_workflow
from .store import DATA, Jobs, Library, slug

MUSIC_KINDS = ("split", "song", "vocals", "practice", "karaoke", "sheet", "daw")
PICTURE_KINDS = ("upscale", "edit")
KINDS = MUSIC_KINDS + PICTURE_KINDS + videojobs.VIDEO_KINDS


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

    def separate(self, job: dict, name: str, src: Path, out: Path) -> tuple[str, str]:
        """Splits `src` into stem files in `out`: on the graphics card when it can, else the CPU.
        Returns the device ("gpu" or "cpu") and a note for the result message."""
        if not self.gpu_stems():
            self.split_on_cpu(job, src, out, "GPU stems are off" if self.gpu_stems_failed else "install the stems node in ComfyUI for the graphics card")
            return "cpu", ""
        try:
            self.split_on_gpu(job, name, src, out)
            return "gpu", ""
        except ComfyError as e:
            # A crash in ComfyUI (often the AMD driver) shouldn't lose the split: finish it on
            # the CPU, and don't send stems to the graphics card again until the studio restarts
            self.gpu_stems_failed = str(e)[:300]
            self.split_on_cpu(job, src, out, "the graphics card failed")
            return "cpu", f" The graphics card failed ({str(e)[:160]}), so it was split on the CPU; GPU stems are off until the studio restarts."

    def do_split(self, job: dict, song: str) -> dict:
        meta = self.song(song)
        src = self.library.original(song)
        out = self.library.dir(song) / "stems"
        self.library.update(song, status="splitting", error=None)
        try:
            device, note = self.separate(job, song, src, out)
        except BaseException as e:
            self.library.update(song, status="failed" if not isinstance(e, InterruptedError) else "new", error=str(e)[:400])
            raise
        stems = [s for s in STEMS if (out / f"{s}.wav").exists()]
        self.library.update(song, status="ready", stems=stems, splitBy=device, error=None)
        return {"message": f"Split “{meta['title']}” into {', '.join(stems)} on the {'graphics card' if device == 'gpu' else 'CPU'}.{note}", "song": song, "files": self.rel(*(out / f"{s}.wav" for s in stems))}

    def ace(self):
        """ACE-Step 1.5 in ComfyUI, or a clear error saying how to get it."""
        if not self.comfy:
            raise ValueError("Songs are made by ACE-Step in ComfyUI: set COMFY_URL for the studio service")
        models = self.comfy.ace_models()
        if not models:
            if not self.comfy.running():
                raise ComfyError("ComfyUI isn't running on the PC")
            raise ValueError("ACE-Step 1.5 isn't in ComfyUI yet: open ComfyUI (http://127.0.0.1:8188), pick Templates > Audio > ACE-Step 1.5 and let it download the models (either the all-in-one checkpoint or the split files), then try again.")
        return models

    def do_vocals(self, job: dict, song: str, lyrics: str, prompt: str = "", strength: float = 0.55, language: str = "en", seed: int | None = None, title: str = "", vocal_level: float = 1.0, split: bool = True) -> dict:
        """Sings lyrics over an instrumental. ACE-Step re-sings the track with the lyrics, starting
        from the instrumental itself (so the timing and key carry over); its vocals are split out and
        laid over the original instrumental. The ACE-Step take is kept too."""
        meta = self.song(song)
        models = self.ace()
        src = self.library.original(song)
        dur = float(meta.get("duration") or audio.duration(src))
        if dur > 600:
            raise ValueError("Vocals can be added to songs up to 10 minutes long")
        bpm, key = meta.get("bpm"), meta.get("key")
        if not bpm or not key:
            self.progress(job, "finding the tempo and key")
            found = analyze.tempo_key(src)
            bpm, key = bpm or found.get("bpm") or 100, key or found.get("key") or "C major"
            self.library.update(song, bpm=int(bpm), key=key)
        seed = int(seed) if seed is not None else random.randrange(1, 2**31)
        strength = max(0.2, min(0.95, float(strength)))
        style = prompt.strip() or meta.get("prompt") or ""
        tags = style if "vocal" in style.lower() or "sing" in style.lower() else ", ".join(x for x in ["lead vocals, clear singing", style] if x)
        title = title.strip() or f"{meta['title']} (vocals)"
        name = slug(title)
        out = self.out_dir("vocals", title, job)
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            self.progress(job, "sending the instrumental to ComfyUI")
            uploaded = self.comfy.upload(src, "mission-control")
            self.progress(job, f"singing the lyrics on the graphics card (ACE-Step 1.5, {int(bpm)} BPM, {key})")
            outputs = self.comfy.run(
                song_workflow(models, tags, lyrics, round(dur, 2), int(bpm), key, "4", language, seed, f"mission-control/vocals/{name}", source=uploaded, denoise=strength),
                timeout=3600,
                cancelled=self.cancelled(job),
                progress=lambda x: self.progress(job, f"singing the lyrics: {x}"),
            )
            files = next(iter(audio_files(outputs).values()), None)
            if not files:
                raise ComfyError("ACE-Step finished but saved no audio")
            take = audio.to_wav(self.comfy.fetch(files[0], t / "take.flac"), t / "take.wav")
            stems_dir = t / "stems"
            device, note = self.separate(job, f"vocals-{song}", take, stems_dir)
            vocals = stems_dir / "vocals.wav"
            if not vocals.exists():
                raise ValueError("Couldn't separate the new vocals")
            self.progress(job, "laying the vocals over your instrumental")
            loud = audio.mix({"music": src, "vocals": vocals}, {"music": 1.0, "vocals": max(0.1, min(2.0, float(vocal_level)))}, t / "loud.wav")
            mixed = audio.to_wav(loud, t / "mixed.wav", end=dur)  # exactly as long as the instrumental
            new = self.library.create(title, "vocals", fromSong=song, prompt=style, lyrics=lyrics, bpm=int(bpm), key=key, seed=seed, strength=strength)
            shutil.copyfile(mixed, self.library.original(new["id"]))
            self.library.update(new["id"], duration=audio.duration(mixed))
            files_out = [
                audio.to_mp3(mixed, out / f"{name}.mp3", loudness=-14),
                audio.to_mp3(take, out / f"{name}-ace-step-take.mp3", loudness=-14),
                shutil.copyfile(vocals, out / f"{name}-vocals-only.wav"),
            ]
        lyr = out / f"{name}-lyrics.txt"
        lyr.write_text(f"{title}\n\nOver: {meta['title']}\nStyle: {tags}\nBPM: {int(bpm)}  Key: {key}  Strength: {strength}  Seed: {seed}  Model: {models['label']}\n\n{lyrics}\n")
        files_out.append(lyr)
        if split:
            self.jobs.add("split", {"song": new["id"]}, f"Split {title}")
            self.wake.set()
        return {
            "message": f"Added vocals to “{meta['title']}”: “{title}” is in the library ({int(bpm)} BPM, {key}). "
            f"Also saved: ACE-Step's own take and the vocals on their own (split on the {'graphics card' if device == 'gpu' else 'CPU'}).{note}",
            "song": new["id"],
            "files": self.rel(*files_out),
        }

    def do_song(self, job: dict, prompt: str, title: str = "", lyrics: str = "", seconds: float = 60, bpm: int = 100, key: str = "C major", timesig: str = "4", language: str = "en", seed: int | None = None, split: bool = True) -> dict:
        models = self.ace()
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

    # --- pictures on the graphics card -------------------------------------------------

    def need_comfy(self) -> Comfy:
        if not self.comfy:
            raise ValueError("Picture jobs run in ComfyUI on the PC: set COMFY_URL for the studio service")
        if not self.comfy.running():
            raise ComfyError("ComfyUI isn't running on the PC")
        return self.comfy

    def do_upscale(self, job: dict, picture: str, model: str = "") -> dict:
        """4x larger and sharper (Real-ESRGAN in ComfyUI), e.g. for a 300 dpi print cover."""
        comfy = self.need_comfy()
        src = pictures.path_of(picture, self.data)
        models = comfy.options("UpscaleModelLoader", "model_name")
        pick = model if model in models else next((m for m in models if "esrgan" in m.lower() and "x4" in m.lower()), None) or (models[0] if models else None)
        if not pick:
            raise ValueError(f"ComfyUI has no upscale model yet: download RealESRGAN_x4plus.pth ({UPSCALE_DOWNLOAD}) into ComfyUI's models\\upscale_models folder, then try again.")
        im = pictures.open_image(src)
        if im.width * im.height > 4_000_000:
            raise ValueError(f"That picture is already {im.width}x{im.height}; 4x would be too large")
        self.progress(job, f"upscaling on the graphics card ({pick})")
        with tempfile.TemporaryDirectory() as tmp:
            flat = Path(tmp) / f"{slug(src.stem)}.png"
            pictures._flatten(im).save(flat)
            name = comfy.upload(flat, "mission-control")
            outputs = comfy.run(upscale_workflow(name, pick, "mission-control/upscaled"), timeout=1800, cancelled=self.cancelled(job), progress=lambda t: self.progress(job, f"upscaling: {t}"))
            files = image_files(outputs)
            if not files:
                raise ComfyError("ComfyUI finished but saved no picture")
            d = pictures.out_dir(f"{src.stem}-4x", self.data)
            dst = comfy.fetch(files[0], d / f"{slug(src.stem)}-4x.png")
        big = pictures.info(dst, self.data)
        return {"message": f"Upscaled {src.name} from {im.width}x{im.height} to {big['width']}x{big['height']} ({pick}).", "files": self.rel(dst), "picture": big["path"]}

    def do_edit(self, job: dict, picture: str, prompt: str, boxes: list, keep: list | None = None, strength: float = 0.9, seed: int | None = None) -> dict:
        """Repaints the boxes of a picture from a description (remove something, change it, even out
        a background); the keep boxes and everything outside the boxes stay exactly as they were."""
        from .js.images import MODEL, TEXT_ENCODER, VAE

        comfy = self.need_comfy()
        src = pictures.path_of(picture, self.data)
        orig = pictures.open_image(src).convert("RGB")
        work = pictures.fit16(orig)
        sx, sy = work.width / orig.width, work.height / orig.height
        scaled = lambda bs: [[b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy] for b in (pictures.clean_box(b, *orig.size) for b in bs)]  # noqa: E731
        seed = int(seed) if seed is not None else random.randrange(1, 2**31)
        self.progress(job, "repainting on the graphics card (Z-Image)")
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            work.save(t / "image.png")
            # A little wider than the boxes, so the new part blends into the old
            pictures.mask_for(work.size, scaled(boxes), scaled(keep or []), feather=4).save(t / "mask.png")
            img_name = comfy.upload(t / "image.png", "mission-control")
            mask_name = comfy.upload(t / "mask.png", "mission-control")
            outputs = comfy.run(
                edit_workflow(img_name, mask_name, prompt[:1500], seed, float(strength), "mission-control/edited", MODEL, TEXT_ENCODER, VAE),
                timeout=1800, cancelled=self.cancelled(job), progress=lambda x: self.progress(job, f"repainting: {x}"),
            )
            files = image_files(outputs)
            if not files:
                raise ComfyError("ComfyUI finished but saved no picture")
            new = pictures.open_image(comfy.fetch(files[0], t / "new.png")).convert("RGB").resize(orig.size)
        # Only the boxes change: the new picture is laid over the original through a soft mask
        soft = pictures.mask_for(orig.size, boxes, keep or [], feather=max(2, min(orig.size) // 200))
        out = orig.copy()
        out.paste(new, (0, 0), soft)
        d = pictures.out_dir(f"{src.stem}-edit", self.data)
        dst = d / f"{slug(src.stem)}-edit.png"
        out.save(dst)
        return {"message": f"Repainted {len(boxes)} part{'s' if len(boxes) != 1 else ''} of {src.name}: {prompt[:80]}", "files": self.rel(dst), "picture": pictures.rel(dst, self.data)}

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
    name = str(params.get("title") or "") or (song["title"] if song else Path(str(params.get("picture") or "")).name or str(params.get("prompt") or "")[:60])
    labels = {"split": "Split", "song": "New song", "vocals": "Add vocals", "upscale": "Upscale 4x", "edit": "Repaint", "practice": "Practice", "karaoke": "Karaoke", "sheet": "Sheet music", "daw": "DAW stems", **videojobs.LABELS}
    return labels[kind] + (f": {name[:60]}" if name else "")


def check_params(kind: str, p: dict, library: Library) -> str | None:
    """What's wrong with a job request, or None."""
    if kind not in KINDS:
        return f"Unknown job type (one of {', '.join(KINDS)})"
    if kind in videojobs.VIDEO_KINDS:
        return videojobs.check(kind, p, library)
    if kind in PICTURE_KINDS:
        try:
            src = pictures.path_of(str(p.get("picture", "")), library.root.parent)
        except ValueError as e:
            return str(e)
        if kind == "edit":
            if not str(p.get("prompt", "")).strip():
                return "Describe what the boxes should show instead"
            boxes = p.get("boxes")
            if not isinstance(boxes, list) or not boxes or not all(isinstance(b, list) and len(b) == 4 for b in boxes):
                return "Give at least one box to repaint: [[x0, y0, x1, y1], ...] in pixels"
            try:
                size = pictures.open_image(src).size
                for b in boxes + list(p.get("keep") or []):
                    pictures.clean_box(b, *size)
            except ValueError as e:
                return str(e)
        return None
    if kind == "song":
        if not str(p.get("prompt", "")).strip():
            return "Describe the song (style, instruments, mood)"
        if len(str(p.get("lyrics", ""))) > 4000:
            return "The lyrics are too long (4000 characters at most)"
        return None
    song = library.get(str(p.get("song", "")))
    if song is None:
        return "Pick a song from the library"
    if kind == "vocals":
        if not str(p.get("lyrics", "")).strip():
            return "Write the lyrics to sing (or ask Jarvis to write them)"
        if len(str(p.get("lyrics", ""))) > 4000:
            return "The lyrics are too long (4000 characters at most)"
        return None
    if kind not in ("split", "vocals") and song.get("status") != "ready":
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


