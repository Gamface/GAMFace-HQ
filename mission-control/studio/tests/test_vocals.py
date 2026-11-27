"""Adding vocals to an instrumental, songs from the shared music folder, and tempo/key detection."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcstudio import analyze, audio, imports  # noqa: E402
from mcstudio.comfy import Comfy, song_workflow  # noqa: E402
from mcstudio.store import Jobs, Library  # noqa: E402
from mcstudio.worker import Worker, check_params, save_upload  # noqa: E402
from test_studio import FakeComfy, small_demucs, tone  # noqa: E402


def beat(path: Path, bpm: int = 120, seconds: float = 12) -> Path:
    """Clicks on the beat over an A minor chord, so tempo and key can be heard."""
    period = 60 / bpm
    chord = "+".join(f"0.2*sin(2*PI*{f}*t)" for f in (220.0, 261.63, 329.63))
    click = f"0.9*sin(2*PI*1000*t)*lt(mod(t\\,{period:.6f})\\,0.03)"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"aevalsrc={chord}+{click}:s=44100:d={seconds}", "-ac", "2", str(path)], check=True)
    return path


class VocalsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.lib = Library(self.tmp)
        self.jobs = Jobs(self.tmp)

    def test_workflow_starts_from_the_instrumental(self):
        wf = song_workflow("ace.safetensors", "lead vocals", "[Verse]\nhello", 30, 120, "A minor", "4", "en", 3, "p", source="mission-control/inst.wav", denoise=0.6)
        self.assertEqual(wf["5a"], {"class_type": "LoadAudio", "inputs": {"audio": "mission-control/inst.wav"}})
        self.assertEqual(wf["5"]["class_type"], "VAEEncodeAudio")
        self.assertEqual(wf["5"]["inputs"]["vae"], ["1", 2])
        self.assertEqual(wf["6"]["inputs"]["latent_image"], ["5", 0])
        self.assertEqual(wf["6"]["inputs"]["denoise"], 0.6)
        self.assertEqual(wf["3"]["inputs"]["lyrics"], "[Verse]\nhello")
        plain = song_workflow("ace.safetensors", "x", "", 30, 120, "A minor", "4", "en", 3, "p", denoise=0.6)
        self.assertEqual((plain["6"]["inputs"]["denoise"], "5a" in plain), (1, False), "denoise only applies with a source")

    def test_tempo_and_key(self):
        found = analyze.tempo_key(beat(self.tmp / "b.wav", 120))
        self.assertAlmostEqual(found["bpm"], 120, delta=4)
        self.assertIn(found["key"], ("A minor", "C major"), "A minor or its relative major")

    def test_add_vocals(self):
        fake = FakeComfy()
        w = Worker(self.lib, self.jobs, Comfy(fake.url), None, self.tmp, cpu_model=small_demucs())
        src = beat(self.tmp / "inst.wav", 100, 10)
        song = save_upload(self.lib, "All Blacks", src.read_bytes(), "inst.wav")
        self.assertEqual(check_params("vocals", {"song": song["id"]}, self.lib), "Write the lyrics to sing (or ask Jarvis to write them)")
        params = {"song": song["id"], "lyrics": "[Verse]\nblack on black\n[Chorus]\nall blacks", "prompt": "trap, male rapper"}
        self.assertIsNone(check_params("vocals", params, self.lib), "works on a song that isn't split yet")
        job = self.jobs.add("vocals", params, "Add vocals")
        w.run(job)
        j = self.jobs.get(job["id"])
        self.assertEqual(j["status"], "done", j.get("error"))
        wf = fake.prompts[-2]  # the ACE-Step run; the last one splits the take on the graphics card
        self.assertEqual(wf["5"]["class_type"], "VAEEncodeAudio")
        self.assertEqual(wf["3"]["inputs"]["tags"], "lead vocals, clear singing, trap, male rapper")
        self.assertAlmostEqual(wf["3"]["inputs"]["bpm"], 100, delta=4)
        self.assertAlmostEqual(wf["3"]["inputs"]["duration"], 10, delta=0.1)
        new = self.lib.get(j["result"]["song"])
        self.assertEqual((new["title"], new["source"], new["fromSong"]), ("All Blacks (vocals)", "vocals", song["id"]))
        self.assertIn("all blacks", new["lyrics"])
        self.assertAlmostEqual(audio.duration(self.lib.original(new["id"])), 10, delta=0.2)
        names = [Path(f).name for f in j["result"]["files"]]
        self.assertEqual(names, ["all-blacks-vocals.mp3", "all-blacks-vocals-ace-step-take.mp3", "all-blacks-vocals-vocals-only.wav", "all-blacks-vocals-lyrics.txt"])
        self.assertTrue(self.lib.get(song["id"])["bpm"], "the tempo is remembered on the instrumental")
        queued = self.jobs.next_queued()
        self.assertEqual((queued["type"], queued["params"]["song"]), ("split", new["id"]))


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "Beats").mkdir()
        tone(self.root / "GAMFACE-ALL BLACKS-INSTRU.mp3", 220, 2)
        tone(self.root / "Beats" / "Night Ride.wav", 330, 2)
        (self.root / "notes.txt").write_text("not audio")
        self.outside = Path(tempfile.mkdtemp()) / "secret.mp3"
        tone(self.outside, 440, 1)

    def test_find(self):
        self.assertEqual(sorted(f["path"] for f in imports.find("", self.root)), ["Beats/Night Ride.wav", "GAMFACE-ALL BLACKS-INSTRU.mp3"])
        self.assertEqual([f["path"] for f in imports.find("all blacks", self.root)], ["GAMFACE-ALL BLACKS-INSTRU.mp3"])

    def test_paths_as_typed_on_the_pc(self):
        want = self.root / "GAMFACE-ALL BLACKS-INSTRU.mp3"
        for host in ("C:\\Users\\aldra\\Music", "/mnt/c/Users/aldra/Music"):
            for typed in ('"C:\\Users\\aldra\\Music\\GAMFACE-ALL BLACKS-INSTRU.mp3"', "/mnt/c/users/aldra/music/gamface-all blacks-instru.mp3", "GAMFACE-ALL BLACKS-INSTRU.mp3"):
                self.assertEqual(imports.resolve(typed, self.root, host), want, (host, typed))
        self.assertEqual(imports.resolve("C:\\Users\\aldra\\Music\\Beats\\Night Ride.wav", self.root, "/mnt/c/Users/aldra/Music"), self.root / "Beats" / "Night Ride.wav")
        # No host folder set (or a different one): found by name
        self.assertEqual(imports.resolve("D:\\Elsewhere\\GAMFACE-ALL BLACKS-INSTRU.mp3", self.root, ""), want)

    def test_nothing_outside_the_folder(self):
        os.symlink(self.outside, self.root / "link.mp3")
        for bad in ("../secret.mp3", "C:\\Users\\aldra\\Music\\..\\secret.mp3", "link.mp3", "notes.txt", str(self.outside)):
            with self.assertRaises(ValueError, msg=bad):
                imports.resolve(bad, self.root, "C:\\Users\\aldra\\Music")

    def test_no_folder_shared(self):
        with self.assertRaisesRegex(ValueError, "MUSIC_DIR"):
            imports.resolve("x.mp3", Path(tempfile.mkdtemp()), "")


if __name__ == "__main__":
    unittest.main()


class ImportServerTests(unittest.TestCase):
    def test_find_and_import_by_pc_path(self):
        import json
        import threading
        import urllib.error
        import urllib.request
        from http.server import ThreadingHTTPServer

        import server

        tmp = Path(tempfile.mkdtemp())
        music = tmp / "music"
        music.mkdir()
        tone(music / "GAMFACE-ALL BLACKS-INSTRU.mp3", 220, 2)
        imports.IMPORT_DIR = music
        os.environ["IMPORT_HOST_DIR"] = "/mnt/c/Users/aldra/Music"
        server.DATA = tmp
        server.library = Library(tmp)
        server.jobs = Jobs(tmp)
        server.worker = Worker(server.library, server.jobs, None, None, tmp)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_port}"

        def call(method, path, body=None):
            req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())

        code, body = call("GET", "/import?q=blacks")
        self.assertEqual((code, [f["path"] for f in body["files"]]), (200, ["GAMFACE-ALL BLACKS-INSTRU.mp3"]))
        code, body = call("POST", "/songs/import", {"path": "C:\\Users\\aldra\\Music\\GAMFACE-ALL BLACKS-INSTRU.mp3", "split": False})
        self.assertEqual(code, 201, body)
        self.assertEqual((body["title"], body["importedFrom"]), ("GAMFACE-ALL BLACKS-INSTRU", "GAMFACE-ALL BLACKS-INSTRU.mp3"))
        self.assertIsNone(server.jobs.next_queued(), "split: false queues nothing")
        code, body = call("POST", "/songs/import", {"path": "C:\\Users\\aldra\\Music\\..\\..\\etc\\passwd"})
        self.assertEqual(code, 400)
        httpd.shutdown()
