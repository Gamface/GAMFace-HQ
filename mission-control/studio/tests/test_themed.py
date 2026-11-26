"""Themed music videos: stock footage (fake Pexels and Pixabay), AI photos (fake ComfyUI) and
your own media, cut to the beat with real ffmpeg and Inkscape.
python -m unittest tests.test_themed -v   (from mission-control/studio)"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcstudio import stock, videojobs  # noqa: E402
from mcstudio.comfy import Comfy  # noqa: E402
from mcstudio.store import Jobs, Library  # noqa: E402
from mcstudio.worker import Worker, check_params, save_upload  # noqa: E402
from test_studio import FakeComfy, FakeVoice, small_demucs  # noqa: E402


class FakeStock:
    """Pexels and Pixabay search answers pointing at real little MP4s and JPEGs served here."""

    def __init__(self):
        tmp = Path(tempfile.mkdtemp())
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=duration=5:size=1280x720:rate=30", str(tmp / "clip.mp4")], check=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=orange:s=1600x900", "-frames:v", "1", str(tmp / "photo.jpg")], check=True)
        self.clip = (tmp / "clip.mp4").read_bytes()
        self.photo = (tmp / "photo.jpg").read_bytes()
        self.searches: list[tuple[str, dict]] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, body: bytes, ctype: str):
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                u = urlparse(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                base = f"http://127.0.0.1:{outer.server.server_port}"
                if u.path.startswith("/files/"):
                    return self.send(outer.clip if u.path.endswith(".mp4") else outer.photo, "application/octet-stream")
                outer.searches.append((u.path, {**q, "auth": self.headers.get("Authorization")}))
                word = (q.get("query") or q.get("q") or "x").replace(" ", "-")
                if u.path == "/pexels/videos/search":
                    vids = [{"id": i, "url": f"https://pexels.example/v/{word}-{i}", "duration": 5, "user": {"name": f"Ana {i}"},
                             "video_files": [{"file_type": "video/mp4", "width": 640, "height": 360, "link": f"{base}/files/{word}-{i}-sd.mp4"},
                                             {"file_type": "video/mp4", "width": 1920, "height": 1080, "link": f"{base}/files/{word}-{i}-hd.mp4"}]} for i in range(3)]
                    return self.send(json.dumps({"videos": vids}).encode(), "application/json")
                if u.path == "/pexels/v1/search":
                    ph = [{"id": i, "url": f"https://pexels.example/p/{word}-{i}", "photographer": f"Ben {i}", "width": 1600, "height": 900, "src": {"large2x": f"{base}/files/{word}-{i}.jpg"}} for i in range(3)]
                    return self.send(json.dumps({"photos": ph}).encode(), "application/json")
                if u.path == "/pixabay/videos/":
                    hits = [{"pageURL": f"https://pixabay.example/v/{word}-{i}", "user": f"Cy {i}", "duration": 6, "videos": {"large": {"url": f"{base}/files/px-{word}-{i}.mp4", "width": 1920, "height": 1080}}} for i in range(2)]
                    return self.send(json.dumps({"hits": hits}).encode(), "application/json")
                if u.path == "/pixabay/":
                    hits = [{"pageURL": f"https://pixabay.example/p/{word}-{i}", "user": f"Di {i}", "largeImageURL": f"{base}/files/px-{word}-{i}.jpg", "imageWidth": 1600, "imageHeight": 900} for i in range(2)]
                    return self.send(json.dumps({"hits": hits}).encode(), "application/json")
                self.send_response(404)
                self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"


class StockSearch(unittest.TestCase):
    def setUp(self):
        self.fake = FakeStock()
        stock.PEXELS_API, stock.PIXABAY_API = f"{self.fake.base}/pexels", f"{self.fake.base}/pixabay"
        os.environ.update(PEXELS_API_KEY="pk", PIXABAY_API_KEY="xk", STOCK_ALLOW_HTTP="1")

    def tearDown(self):
        for k in ("PEXELS_API_KEY", "PIXABAY_API_KEY", "STOCK_ALLOW_HTTP"):
            os.environ.pop(k, None)

    def test_find_spreads_over_phrases_and_kinds(self):
        items = stock.find("beach sunset, friends laughing", "16:9", 8)
        self.assertEqual(len(items), 8)
        self.assertEqual(sum(i.kind == "video" for i in items), 5, "about 60% clips")
        self.assertEqual({i.query for i in items}, {"beach sunset", "friends laughing"})
        self.assertTrue(all("-hd.mp4" in i.url for i in items if i.source == "pexels" and i.kind == "video"), "the 1080p file, not the small one")
        pex = [q for p, q in self.fake.searches if p.startswith("/pexels")]
        self.assertTrue(all(q["auth"] == "pk" and q["orientation"] == "landscape" for q in pex))
        self.assertTrue(any(q.get("orientation") == "horizontal" for p, q in self.fake.searches if p == "/pixabay/"))

    def test_without_keys_nothing_is_searched(self):
        os.environ.pop("PEXELS_API_KEY")
        os.environ.pop("PIXABAY_API_KEY")
        self.assertEqual(stock.find("anything", "9:16", 5), [])
        self.assertEqual(stock.keys(), {"pexels": False, "pixabay": False})

    def test_credits_and_https_only(self):
        it = stock.Item("photo", "http://evil.example/x.jpg", "page", "Ann on Pexels", "pexels", "q")
        os.environ.pop("STOCK_ALLOW_HTTP")
        with self.assertRaisesRegex(RuntimeError, "non-https"):
            stock.download(it, Path(tempfile.mkdtemp()), 1)
        text = stock.credits([(it, Path("01-pexels-q.jpg"))], ["a prompt"])
        self.assertIn("01-pexels-q.jpg: photo by Ann on Pexels (page)", text)
        self.assertIn("Photos and videos provided by Pexels", text)
        self.assertIn("AI-made pictures", text)
        self.assertEqual(stock.queries("a, b;c\nd"), ["a", "b", "c", "d"])


@unittest.skipUnless(shutil.which("inkscape"), "Inkscape not installed")
class ThemedVideo(unittest.TestCase):
    def setUp(self):
        self.fake = FakeStock()
        stock.PEXELS_API, stock.PIXABAY_API = f"{self.fake.base}/pexels", f"{self.fake.base}/pixabay"
        os.environ.update(PEXELS_API_KEY="pk", PIXABAY_API_KEY="xk", STOCK_ALLOW_HTTP="1")
        self.tmp = Path(tempfile.mkdtemp())
        self.lib = Library(self.tmp)
        self.jobs = Jobs(self.tmp)
        self.comfy = FakeComfy()
        self.worker = Worker(self.lib, self.jobs, Comfy(self.comfy.url), FakeVoice().url, self.tmp, cpu_model=small_demucs())
        src = self.tmp / "s.wav"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=16", "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,0.5),0.03),0.9*sin(2*PI*1000*t),0)':d=16:s=44100", "-filter_complex", "amix=inputs=2", "-ac", "2", str(src)], check=True)
        self.song = save_upload(self.lib, "Summer Road", src.read_bytes(), "s.wav")
        self.worker.run(self.jobs.add("split", {"song": self.song["id"]}, "split"))

    def tearDown(self):
        for k in ("PEXELS_API_KEY", "PIXABAY_API_KEY", "STOCK_ALLOW_HTTP"):
            os.environ.pop(k, None)

    def run_job(self, **params):
        err = check_params("themed_video", params, self.lib)
        self.assertIsNone(err, err)
        j = self.jobs.add("themed_video", params, "themed")
        self.worker.run(j)
        j = self.jobs.get(j["id"])
        self.assertEqual(j["status"], "done", j.get("error"))
        return j["result"]

    def test_stock_ai_and_mine_cut_to_the_beat(self):
        own = self.tmp / "own.jpg"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=1200x800", "-frames:v", "1", str(own)], check=True)
        videojobs.save_media("family", "own.jpg", base64.b64encode(own.read_bytes()).decode(), self.tmp)
        r = self.run_job(song=self.song["id"], theme="open road, sunset over the sea", sources=["stock", "ai", "media"], media="media/family", count=8, aspect="16:9", pace="fast", max_len=10, lyrics=False)
        self.assertIn("stock shots", r["message"])
        mp4 = next(self.tmp / f for f in r["files"] if f.endswith(".mp4"))
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0:s=,", str(mp4)], capture_output=True, text=True).stdout.split()
        self.assertEqual(out[0].split(",")[:2], ["1920", "1080"])
        self.assertAlmostEqual(float(out[-1]), 10.0, delta=1.0)
        credits = next(self.tmp / f for f in r["files"] if f.endswith("credits.txt")).read_text()
        self.assertIn("on Pexels", credits)
        self.assertIn("AI-made pictures", credits)
        footage = sorted(p.name for p in (self.tmp / "media" / "themed-summer-road").iterdir())
        self.assertTrue(any("-mine-" in f for f in footage) and any("-ai-" in f for f in footage) and any("-pexels-" in f for f in footage), footage)
        self.assertEqual(len(footage), 8)

    def test_ai_photos_only_without_keys(self):
        os.environ.pop("PEXELS_API_KEY")
        os.environ.pop("PIXABAY_API_KEY")
        self.assertIn("needs a free Pexels or Pixabay API key", check_params("themed_video", {"song": self.song["id"], "sources": ["stock"]}, self.lib))
        r = self.run_job(song=self.song["id"], theme="rainy city at night", sources=["ai"], count=4, aspect="9:16", max_len=6)
        self.assertIn("4 AI photos", r["message"])
        pics = [p for p in self.comfy.prompts if any(n["class_type"] == "SaveImage" for n in p.values())]
        self.assertEqual(len(pics), 4)
        self.assertIn("rainy city at night, realistic photograph", pics[0]["5"]["inputs"]["text"])
        self.assertEqual((pics[0]["7"]["inputs"]["width"], pics[0]["7"]["inputs"]["height"]), (832, 1216), "portrait for 9:16")


if __name__ == "__main__":
    unittest.main()
