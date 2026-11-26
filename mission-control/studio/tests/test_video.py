"""Tests for the video workflows (Jarvis Studio's, in mcstudio/js/video) running as studio jobs.
python -m unittest tests.test_video -v   (from mission-control/studio)

Real ffmpeg and Inkscape (skipped without it); a fake ComfyUI and voice service; an untrained
Demucs for the stems."""

from __future__ import annotations

import base64
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcstudio import videojobs  # noqa: E402
from mcstudio.comfy import Comfy  # noqa: E402
from mcstudio.store import Jobs, Library  # noqa: E402
from mcstudio.worker import Worker, check_params, save_upload  # noqa: E402
from test_studio import FakeComfy, FakeVoice, small_demucs  # noqa: E402

HAVE_INKSCAPE = shutil.which("inkscape") is not None


def probe(path: Path) -> tuple[float, int, int]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0:s=,", str(path)], capture_output=True, text=True).stdout.split()
    w, h = (int(x) for x in out[0].split(",")[:2])
    return float(out[-1]), w, h


@unittest.skipUnless(HAVE_INKSCAPE, "Inkscape not installed (title cards and slides)")
class VideoJobs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.lib = Library(cls.tmp)
        cls.jobs = Jobs(cls.tmp)
        cls.voice = FakeVoice()
        cls.comfy = FakeComfy()
        cls.worker = Worker(cls.lib, cls.jobs, Comfy(cls.comfy.url), cls.voice.url, cls.tmp, cpu_model=small_demucs())
        # A 20 s song with a beat (clicks) so tempo and beat-cuts have something to find
        src = cls.tmp / "beat.wav"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=20", "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,0.5),0.03),0.9*sin(2*PI*1000*t),0)':d=20:s=44100",
                        "-filter_complex", "amix=inputs=2", "-ac", "2", str(src)], check=True)
        cls.song = save_upload(cls.lib, "Beat Song", src.read_bytes(), "beat.wav")
        cls.worker.cpu_model = small_demucs()
        cls.worker.run(cls.jobs.add("split", {"song": cls.song["id"]}, "split"))
        assert cls.lib.get(cls.song["id"])["status"] == "ready"

    def job(self, kind, **params):
        err = check_params(kind, params, self.lib)
        self.assertIsNone(err, err)
        j = self.jobs.add(kind, params, kind)
        self.worker.run(j)
        j = self.jobs.get(j["id"])
        self.assertEqual(j["status"], "done", j.get("error"))
        return j["result"]

    def mp4s(self, result):
        return [self.tmp / f for f in result["files"] if f.endswith(".mp4")]

    def test_music_video_stems_vertical(self):
        r = self.job("music_video", song=self.song["id"], style="stems", aspect="9:16", start=2, end=8, lyrics=False)
        vids = self.mp4s(r)
        self.assertTrue(vids, r)
        dur, w, h = probe(vids[0])
        self.assertEqual((w, h), (1080, 1920))
        self.assertAlmostEqual(dur, 6.0, delta=0.6)
        self.assertTrue(any(f.endswith(".png") or f.endswith(".jpg") for f in r["files"]), "a thumbnail")

    def test_shorts_from_a_song(self):
        r = self.job("shorts", song=self.song["id"], platforms=["shorts", "square"], length=6, caption="none")
        sizes = sorted(probe(v)[1:] for v in self.mp4s(r))
        self.assertIn((1080, 1080), sizes)
        self.assertIn((1080, 1920), sizes)

    def test_beat_edit_from_uploaded_clips_and_photos(self):
        for i in range(3):
            clip = self.tmp / f"c{i}.mp4"
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=640x360:rate=30", "-f", "lavfi", "-i", "sine=duration=3", "-shortest", str(clip)], check=True)
            videojobs.save_media("trip", f"clip{i}.mp4", base64.b64encode(clip.read_bytes()).decode(), self.tmp)
        photo = self.tmp / "p.png"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=800x600", "-frames:v", "1", str(photo)], check=True)
        videojobs.save_media("trip", "photo.png", base64.b64encode(photo.read_bytes()).decode(), self.tmp)
        self.assertEqual(len(videojobs.list_media(self.tmp)[0]["files"]), 4)
        r = self.job("beat_edit", media="media/trip", song=self.song["id"], pace="fast", max_len=8)
        dur, w, h = probe(self.mp4s(r)[0])
        self.assertEqual((w, h), (1920, 1080))
        self.assertAlmostEqual(dur, 8.0, delta=1.0)
        self.assertTrue(any(f.endswith(".otio") for f in r["files"]), "a Kdenlive timeline")

    def test_narrated_with_kokoro_and_music(self):
        r = self.job("narrated", script="The first idea is simple.\n\nThe second one builds on it.\n\nAnd that is the whole story.", title="How It Works", music=self.song["id"], aspect="16:9")
        dur, w, _ = probe(self.mp4s(r)[0])
        self.assertEqual(w, 1920)
        self.assertGreater(dur, 4)
        self.assertTrue(any(f.endswith(".srt") for f in r["files"]), "subtitles from the script")

    def test_captions_on_an_uploaded_video(self):
        talk = self.tmp / "talk.mp4"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=5:size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=duration=5", "-shortest", str(talk)], check=True)
        m = videojobs.save_media("talks", "talk.mp4", base64.b64encode(talk.read_bytes()).decode(), self.tmp)
        r = self.job("captions", video=m["path"], style="pop", burn=True)
        self.assertTrue(any(f.endswith(".srt") for f in r["files"]))
        self.assertTrue(self.mp4s(r))

    def test_explainer_with_pictures_from_comfyui(self):
        script = "# Getting started\nStems let you hear every part of a song on its own.\n\nMute the guitar and play along with the band.\n\n# Going further\nSlow the song down without changing its key."
        r = self.job("explainer", title="Why Stems Help", script=script, aspect="16:9", style="watercolor storybook", music=self.song["id"])
        dur, w, h = probe(self.mp4s(r)[0])
        self.assertEqual((w, h), (1920, 1080))
        self.assertGreater(dur, 6)
        self.assertTrue(any(f.endswith("chapters.txt") for f in r["files"]), "YouTube chapters")
        # Pictures came from ComfyUI's Z-Image workflow
        pics = [p for p in self.comfy.prompts if any(n["class_type"] == "SaveImage" for n in p.values())]
        self.assertTrue(pics)
        self.assertEqual(pics[0]["1"]["inputs"]["unet_name"], "z_image_turbo_bf16.safetensors")

    def test_checks(self):
        self.assertEqual(check_params("beat_edit", {"media": "../../etc", "song": self.song["id"]}, self.lib), "That isn't in the studio's media")
        self.assertEqual(check_params("narrated", {"script": "hi"}, self.lib), "Write the script (one paragraph per slide)")
        self.assertIn("Pick a song", check_params("music_video", {}, self.lib))
        with self.assertRaisesRegex(ValueError, "video, photo, audio"):
            videojobs.save_media("x", "evil.exe", base64.b64encode(b"MZ").decode(), self.tmp)


if __name__ == "__main__":
    unittest.main()
