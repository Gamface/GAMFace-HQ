"""Tests for the studio service.   python -m unittest discover -s tests -v   (from mission-control/studio)

They run the real ffmpeg, rubberband, basic-pitch (ONNX) and MuseScore when installed, and an
untrained Demucs (the right shape, random weights) so no download is needed. ComfyUI and the
voice service are small fakes."""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcstudio import audio, daw, karaoke, separate, sheet  # noqa: E402
from mcstudio.comfy import STEM_NODE, Comfy, song_workflow, split_workflow  # noqa: E402
from mcstudio.store import Jobs, Library, outputs, slug  # noqa: E402
from mcstudio.worker import Worker, check_params, save_upload  # noqa: E402

HAVE_RUBBERBAND = shutil.which("rubberband") is not None
HAVE_MUSESCORE = sheet.musescore() is not None


def tone(path: Path, freq: float = 440, seconds: float = 3, sr: int = 44100, channels: int = 2) -> Path:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}:sample_rate={sr}", "-ac", str(channels), str(path)], check=True)
    return path


def small_demucs():
    import torchaudio

    return torchaudio.models.hdemucs_low(sources=["drums", "bass", "other", "vocals"])


class AudioTests(unittest.TestCase):
    def test_convert_mix_stretch_encode(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            a = audio.to_wav(tone(d / "a.mp3", 220, 2), d / "a.wav")
            b = audio.to_wav(tone(d / "b.flac", 330, 2, channels=1), d / "b.wav")
            self.assertAlmostEqual(audio.duration(a), 2.0, delta=0.1)
            m = audio.mix({"x": a, "y": b}, {"y": 0}, d / "m.wav", start=0.5, end=1.5)
            self.assertAlmostEqual(audio.duration(m), 1.0, delta=0.1)
            with self.assertRaisesRegex(audio.AudioError, "Every part is muted"):
                audio.mix({"x": a}, {"x": 0}, d / "none.wav")
            mp3 = audio.to_mp3(m, d / "m.mp3", loudness=-14)
            self.assertGreater(mp3.stat().st_size, 1000)
            self.assertEqual(audio.stretch(a, d / "same.wav").read_bytes(), a.read_bytes(), "no change: a copy")
            with self.assertRaisesRegex(audio.AudioError, "no audio"):
                bad = d / "bad.mp3"
                bad.write_text("not audio")
                audio.duration(bad)

    @unittest.skipUnless(HAVE_RUBBERBAND, "rubberband not installed")
    def test_stretch_changes_length_not_key(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            a = audio.to_wav(tone(d / "a.wav", 440, 2), d / "a2.wav")
            slow = audio.stretch(a, d / "slow.wav", speed=0.5)
            self.assertAlmostEqual(audio.duration(slow), 4.0, delta=0.2)
            up = audio.stretch(a, d / "up.wav", semitones=2)
            self.assertAlmostEqual(audio.duration(up), 2.0, delta=0.1)


class SeparationTests(unittest.TestCase):
    def test_split_writes_four_aligned_stems(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            src = audio.to_wav(tone(d / "song.wav", 220, 23), d / "song44.wav")
            seen = []
            stems = separate.split(src, d / "stems", small_demucs(), progress=seen.append)
            self.assertEqual(list(stems), ["vocals", "drums", "bass", "other"])
            for p in stems.values():
                self.assertAlmostEqual(audio.duration(p), 23.0, delta=0.05)
            self.assertEqual(seen[-1], 1.0)
            self.assertGreater(len(seen), 1, "processed in chunks")
            with self.assertRaises(InterruptedError):
                separate.split(src, d / "stems2", small_demucs(), cancelled=lambda: True)


class KaraokeTests(unittest.TestCase):
    def test_lines_and_lrc(self):
        words = [{"text": "hello", "start": 1.0, "end": 1.4}, {"text": "world", "start": 1.5, "end": 2.0}, {"text": "again", "start": 3.5, "end": 4.0}, {"text": " ", "start": 4, "end": 4}]
        lines = karaoke.lines_from_words(words)
        self.assertEqual([[w["text"] for w in ln["words"]] for ln in lines], [["hello", "world"], ["again"]])
        text = karaoke.lrc(lines, "Song")
        self.assertIn("[00:01.00]hello world", text)
        self.assertIn("[00:03.50]again", text)
        self.assertIn("[00:01.00]<00:01.00>hello <00:01.50>world", karaoke.lrc(lines, "Song", word_times=True))
        self.assertNotIn("hello", karaoke.lrc(lines, "Song", offset=3.0), "lines before a clip's start are dropped")
        self.assertEqual(karaoke.stamp(75.5), "01:15.50")


class DawTests(unittest.TestCase):
    def test_zip_with_reaper_project(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            v = tone(d / "vocals.wav", 440, 1)
            z = daw.export("My Song", "my-song", {"vocals": v}, {"vocals": 1.0}, d / "out.zip", bpm=90)
            with zipfile.ZipFile(z) as zf:
                self.assertEqual(sorted(zf.namelist()), ["README.txt", "my-song.rpp", "stems/vocals.wav"])
                rpp = zf.read("my-song.rpp").decode()
                self.assertIn('FILE "stems/vocals.wav"', rpp)
                self.assertIn("TEMPO 90.00 4 4", rpp)
                self.assertIn("LENGTH 1.000", rpp)


class SheetTests(unittest.TestCase):
    def test_tone_becomes_midi_and_pdf(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            src = tone(d / "bass.wav", 110, 3)
            n = sheet.to_midi(src, d / "bass.mid", "bass")
            self.assertGreater(n, 0, "basic-pitch heard the note")
            import pretty_midi

            pm = pretty_midi.PrettyMIDI(str(d / "bass.mid"))
            self.assertEqual(pm.instruments[0].program, 33)
            pitches = {note.pitch for note in pm.instruments[0].notes}
            self.assertIn(45, pitches, "A2 (110 Hz)")
            if HAVE_MUSESCORE:
                made = sheet.engrave(d / "bass.mid", d)
                self.assertIn(d / "bass.pdf", made)
                self.assertTrue((d / "bass.pdf").read_bytes().startswith(b"%PDF"))


class FakeComfy:
    """Enough of ComfyUI's API: object_info, upload, prompt, history, view."""

    def __init__(self, with_stems=True, ace="ace_step_1.5_turbo_aio.safetensors"):
        self.with_stems = with_stems
        self.ace = ace
        self.prompts: list[dict] = []
        self.uploads: list[str] = []
        self.files: dict[str, bytes] = {}
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, code, body, ctype="application/json"):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == "/system_stats":
                    return self.reply(200, {"system": {}})
                if self.path.startswith("/object_info/"):
                    node = self.path.split("/")[-1]
                    if node == STEM_NODE:
                        return self.reply(200, {STEM_NODE: {"input": {}}} if outer.with_stems else {})
                    if node == "CheckpointLoaderSimple":
                        return self.reply(200, {node: {"input": {"required": {"ckpt_name": [[x for x in ["sdxl.safetensors", outer.ace] if x]]}}}})
                    return self.reply(200, {})
                if self.path.startswith("/history/"):
                    pid = self.path.split("/")[-1]
                    wf = outer.prompts[int(pid)]
                    outs = {}
                    for nid, node in wf.items():
                        if node["class_type"] == "SaveAudio":
                            name = node["inputs"]["filename_prefix"].replace("/", "_") + ".flac"
                            outs[nid] = {"audio": [{"filename": name, "subfolder": "", "type": "output"}]}
                            outer.files[name] = outer.flac
                        if node["class_type"] == "SaveImage":
                            name = f"pic-{pid}.png"
                            outs[nid] = {"images": [{"filename": name, "subfolder": "", "type": "output"}]}
                            outer.files[name] = outer.png
                    return self.reply(200, {pid: {"status": {"status_str": "success", "completed": True}, "outputs": outs}})
                if self.path.startswith("/view?"):
                    from urllib.parse import parse_qs, urlparse

                    name = parse_qs(urlparse(self.path).query)["filename"][0]
                    return self.reply(200, outer.files[name], "audio/flac")
                self.reply(404, {})

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if self.path == "/upload/image":
                    outer.uploads.append(body[:200].decode("latin1"))
                    return self.reply(200, {"name": "song.wav", "subfolder": "mission-control", "type": "input"})
                if self.path == "/prompt":
                    outer.prompts.append(json.loads(body)["prompt"])
                    return self.reply(200, {"prompt_id": str(len(outer.prompts) - 1)})
                self.reply(200, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        tmp = Path(tempfile.mkdtemp())
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=12:sample_rate=48000", "-ac", "2", str(tmp / "s.flac")], check=True)
        self.flac = (tmp / "s.flac").read_bytes()
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "gradients=s=1216x832", "-frames:v", "1", str(tmp / "p.png")], check=True)
        self.png = (tmp / "p.png").read_bytes()


class FakeVoice:
    def __init__(self):
        self.calls = 0
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/speak":
                    # A tone as long as the text would take to say, with evenly spread word timings
                    words = body["text"].split()
                    secs = max(1.0, len(words) * 0.35)
                    with tempfile.TemporaryDirectory() as td:
                        wav = tone(Path(td) / "s.wav", 200, secs, 24000, 1)
                        audio_b64 = base64.b64encode(wav.read_bytes()).decode()
                    timed = [{"text": w, "start": round(i * 0.35, 3), "end": round(i * 0.35 + 0.3, 3)} for i, w in enumerate(words)]
                    data = json.dumps({"audio": audio_b64, "seconds": secs, "words": timed, "voice": body.get("voice")}).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                raw = base64.b64decode(body["audio"])
                assert raw[:4] == b"RIFF", "the voice service gets a WAV"
                outer.calls += 1
                data = json.dumps({"words": [{"text": "la", "start": 0.5, "end": 0.9}, {"text": "la", "start": 1.0, "end": 1.3}, {"text": "end", "start": 3.0, "end": 3.4}]}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"


class WorkflowTests(unittest.TestCase):
    def test_song_workflow_matches_comfys_template(self):
        wf = song_workflow("ace.safetensors", "lofi", "", 30, 90, "A minor", "3", "es", 7, "mission-control/songs/x")
        self.assertEqual(wf["3"]["class_type"], "TextEncodeAceStepAudio1.5")
        self.assertEqual(wf["3"]["inputs"]["lyrics"], "[Instrumental]")
        self.assertEqual(wf["3"]["inputs"]["keyscale"], "A minor")
        self.assertEqual(wf["5"]["class_type"], "EmptyAceStep1.5LatentAudio")
        self.assertEqual((wf["6"]["inputs"]["steps"], wf["6"]["inputs"]["cfg"], wf["6"]["inputs"]["sampler_name"]), (8, 1, "euler"))
        self.assertEqual(wf["2"]["inputs"]["shift"], 3)
        odd = song_workflow("a", "t", "l", 30, 90, "H major", "5", "xx", 1, "p")
        self.assertEqual((odd["3"]["inputs"]["keyscale"], odd["3"]["inputs"]["timesignature"], odd["3"]["inputs"]["language"]), ("C major", "4", "en"))
        sp = split_workflow("mission-control/song.wav", "mc/stems/1")
        self.assertEqual(sp["2"]["class_type"], STEM_NODE)
        self.assertEqual([sp[str(10 + i)]["inputs"]["audio"] for i in range(4)], [["2", 0], ["2", 1], ["2", 2], ["2", 3]])


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.lib = Library(self.tmp)
        self.jobs = Jobs(self.tmp)

    def run_job(self, w: Worker, kind: str, **params):
        err = check_params(kind, params, self.lib)
        self.assertIsNone(err, err)
        job = self.jobs.add(kind, params, kind)
        w.run(job)
        return self.jobs.get(job["id"])

    def upload(self, seconds=6):
        src = tone(self.tmp / "in.mp3", 220, seconds)
        return save_upload(self.lib, "Test Song", src.read_bytes(), "in.mp3")

    def test_cpu_split_then_practice_karaoke_sheet_daw(self):
        voice = FakeVoice()
        w = Worker(self.lib, self.jobs, Comfy("http://127.0.0.1:9"), voice.url, self.tmp, cpu_model=small_demucs())
        song = self.upload()
        self.assertEqual(check_params("practice", {"song": song["id"]}, self.lib), "That song hasn't been split into stems yet")
        j = self.run_job(w, "split", song=song["id"])
        self.assertEqual(j["status"], "done", j.get("error"))
        meta = self.lib.get(song["id"])
        self.assertEqual((meta["status"], meta["splitBy"], meta["stems"]), ("ready", "cpu", ["vocals", "drums", "bass", "other"]))

        j = self.run_job(w, "practice", song=song["id"], gains={"vocals": 0}, speed=1.0, semitones=0, start=1, end=3)
        self.assertEqual(j["status"], "done", j.get("error"))
        self.assertIn("no vocals", j["result"]["message"])
        mp3 = self.tmp / j["result"]["files"][0]
        self.assertAlmostEqual(audio.duration(mp3), 2.0, delta=0.15)

        j = self.run_job(w, "karaoke", song=song["id"])
        self.assertEqual(j["status"], "done", j.get("error"))
        self.assertIn("2 lines of timed lyrics", j["result"]["message"])
        lrc = next(f for f in j["result"]["files"] if f.endswith("song.lrc"))
        self.assertIn("[00:00.50]la la", (self.tmp / lrc).read_text())
        self.run_job(w, "karaoke", song=song["id"])
        self.assertEqual(voice.calls, 1, "lyrics are kept with the song and reused")

        j = self.run_job(w, "sheet", song=song["id"], parts=["bass", "drums"])
        self.assertEqual(j["status"], "done", j.get("error"))
        self.assertTrue(any(f.endswith("-bass.mid") for f in j["result"]["files"]))
        self.assertFalse(any("drums" in f for f in j["result"]["files"]), "drums have no notes to write out")

        j = self.run_job(w, "daw", song=song["id"])
        self.assertEqual(j["status"], "done", j.get("error"))
        with zipfile.ZipFile(self.tmp / j["result"]["files"][0]) as z:
            self.assertEqual(len([n for n in z.namelist() if n.startswith("stems/")]), 4)

        kinds = sorted({o["kind"] for o in outputs(self.tmp)})
        self.assertEqual(kinds, ["daw", "karaoke", "practice", "sheet"])

    def test_gpu_split_and_ace_step_song_through_comfyui(self):
        fake = FakeComfy()
        w = Worker(self.lib, self.jobs, Comfy(fake.url), None, self.tmp)
        song = self.upload()
        j = self.run_job(w, "split", song=song["id"])
        self.assertEqual(j["status"], "done", j.get("error"))
        self.assertEqual(self.lib.get(song["id"])["splitBy"], "gpu")
        self.assertEqual(fake.prompts[0]["2"]["class_type"], STEM_NODE)
        self.assertIn('name="type"', fake.uploads[0])
        stems = self.lib.stems(song["id"])
        self.assertEqual(len(stems), 4)
        self.assertAlmostEqual(audio.duration(stems["vocals"]), 12.0, delta=0.1)

        j = self.run_job(w, "song", prompt="lofi hip hop, warm keys", title="Night Drive", seconds=12, bpm=85, key="A minor")
        self.assertEqual(j["status"], "done", j.get("error"))
        wf = fake.prompts[-1]
        self.assertEqual(wf["1"]["inputs"]["ckpt_name"], "ace_step_1.5_turbo_aio.safetensors")
        self.assertEqual(wf["3"]["inputs"]["bpm"], 85)
        new = self.lib.get(j["result"]["song"])
        self.assertEqual((new["title"], new["source"], new["bpm"]), ("Night Drive", "ace-step", 85))
        self.assertTrue(any(f.endswith("night-drive.mp3") for f in j["result"]["files"]))
        queued = self.jobs.next_queued()
        self.assertEqual((queued["type"], queued["params"]["song"]), ("split", new["id"]), "a new song is split next")

    def test_missing_ace_step_says_how_to_get_it(self):
        fake = FakeComfy(ace=None)
        w = Worker(self.lib, self.jobs, Comfy(fake.url), None, self.tmp)
        j = self.run_job(w, "song", prompt="anything")
        self.assertEqual(j["status"], "failed")
        self.assertIn("ace_step_1.5_turbo_aio.safetensors", j["error"])

    def test_checks_and_restart(self):
        self.assertEqual(check_params("nope", {}, self.lib)[:16], "Unknown job type")
        self.assertEqual(check_params("song", {"prompt": " "}, self.lib), "Describe the song (style, instruments, mood)")
        self.assertEqual(check_params("karaoke", {"song": "000000000000"}, self.lib), "Pick a song from the library")
        job = self.jobs.add("split", {"song": "x"}, "t")
        self.jobs.update(job, status="running")
        again = Jobs(self.tmp)
        self.assertEqual(again.get(job["id"])["status"], "failed")
        self.assertIn("Interrupted", again.get(job["id"])["error"])
        self.assertEqual(slug("Héllo, World!"), "hello-world")
        with self.assertRaises(KeyError):
            self.lib.dir("../etc")


class ServerTests(unittest.TestCase):
    def test_upload_split_and_files(self):
        import server

        tmp = Path(tempfile.mkdtemp())
        server.DATA = tmp
        server.library = Library(tmp)
        server.jobs = Jobs(tmp)
        server.worker = Worker(server.library, server.jobs, None, None, tmp, cpu_model=small_demucs())
        server.worker.start()
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_port}"

        def call(method, path, body=None, headers=None):
            req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={"Content-Type": "application/json", **(headers or {})})
            try:
                with urllib.request.urlopen(req) as r:
                    return r.status, r.read(), dict(r.headers)
            except urllib.error.HTTPError as e:
                return e.code, e.read(), dict(e.headers)

        data = base64.b64encode(tone(tmp / "u.wav", 300, 4).read_bytes()).decode()
        code, body, _ = call("POST", "/songs", {"title": "Upload", "filename": "u.wav", "data": f"data:audio/wav;base64,{data}"})
        self.assertEqual(code, 201, body)
        sid = json.loads(body)["id"]
        for _ in range(120):
            song = json.loads(call("GET", f"/songs/{sid}")[1])
            if song["status"] in ("ready", "failed"):
                break
            time.sleep(0.5)
        self.assertEqual(song["status"], "ready", song)
        code, body, _ = call("POST", "/jobs", {"type": "practice", "song": sid, "speed": 1, "evil": "x"})
        self.assertEqual(code, 201)
        self.assertNotIn("evil", json.loads(body)["params"])
        code, body, headers = call("GET", f"/files/library/{sid}/stems/vocals.wav", headers={"Range": "bytes=0-99"})
        self.assertEqual((code, len(body), headers["Content-Range"].split("/")[0]), (206, 100, "bytes 0-99"))
        self.assertEqual(call("GET", "/files/../../etc/passwd")[0], 404)
        self.assertEqual(call("GET", f"/files/library/{sid}/meta.json")[0], 404, "JSON state isn't served")
        self.assertEqual(call("POST", "/songs", {"data": "!!notbase64"})[0], 400)
        self.assertEqual(call("POST", "/jobs", {"type": "sheet", "song": "000000000000"})[0], 400)
        self.assertEqual(call("DELETE", f"/songs/{sid}")[0] in (200, 409), True)
        httpd.shutdown()


if __name__ == "__main__":
    unittest.main()
