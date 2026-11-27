"""The studio's picture tools: adding, text, SVG, previews, composite, convert, trash, and the
graphics-card jobs (upscale, repaint) against the fake ComfyUI."""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image  # noqa: E402

from mcstudio import imports, pictures  # noqa: E402
from mcstudio.comfy import Comfy, edit_workflow, upscale_workflow  # noqa: E402
from mcstudio.store import Jobs, Library  # noqa: E402
from mcstudio.worker import Worker, check_params  # noqa: E402
from test_studio import FakeComfy  # noqa: E402


def png(w=400, h=300, color=(30, 60, 200)) -> bytes:
    buf = io.BytesIO()
    im = Image.new("RGB", (w, h), color)
    for x in range(w // 2, w):  # a right half of another colour, so placement can be checked
        for y in range(0, h, 1):
            im.putpixel((x, y), (220, 40, 40))
    im.save(buf, "PNG")
    return buf.getvalue()


class PictureTests(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp())
        self.pic = pictures.add(png(), "My Cover.png", self.data)["path"]

    def test_add_any_kind_and_path_checks(self):
        self.assertEqual(self.pic, "pictures/my-cover.png")
        again = pictures.add(png(), "My Cover.png", self.data)
        self.assertEqual(again["path"], "pictures/my-cover-2.png", "never overwrites")
        buf = io.BytesIO()
        Image.new("RGB", (50, 40), "white").save(buf, "TIFF")
        self.assertEqual(pictures.add(buf.getvalue(), "scan.tif", self.data)["path"], "pictures/scan.png")
        svg = pictures.add(b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#f00"/></svg>', "logo.svg", self.data)
        self.assertEqual((svg["path"], svg["width"]), ("pictures/logo.png", 120))
        for bad in ("../etc/passwd", "library/x/original.wav", "jobs.json", "/etc/hostname", "pictures/../../x.png"):
            with self.assertRaises(ValueError, msg=bad):
                pictures.path_of(bad, self.data)
        with self.assertRaises(ValueError):
            pictures.add(b"not a picture", "x.png", self.data)

    def test_text_on_a_picture(self):
        out = pictures.text_on(pictures.path_of(self.pic, self.data), "ALL BLACKS", "GAMFACE", "bottom-left", data=self.data)
        im = Image.open(self.data / out["file"])
        self.assertEqual(im.size, (400, 300))
        self.assertTrue(out["preview"])
        # White text appeared in the lower left, the top right is untouched
        lower_left = im.convert("RGB").crop((20, 180, 200, 280))
        self.assertGreater(max(p[0] + p[1] + p[2] for p in lower_left.getdata()), 600)
        self.assertEqual(im.convert("RGB").getpixel((390, 10)), (220, 40, 40))

    def test_svg_designs_are_checked_and_rendered(self):
        ok = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect width="300" height="100" fill="url(#g)"/><text x="10" y="60" font-size="40" fill="#fff">Hi</text></svg>'
        out = pictures.render_svg(ok, "Title Card", data=self.data)
        self.assertEqual((out["width"], out["height"]), (300, 100))
        pdf = pictures.render_svg(ok, "Title Card", "pdf", data=self.data)
        self.assertTrue(pdf["file"].endswith(".pdf"))
        for bad in (
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="/data/jobs.json"/></svg>',
            '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
            '<svg><script>alert(1)</script></svg>',
            '<svg><style>@import url(http://x/y.css);</style></svg>',
            '<svg><rect style="fill:url(http://x/a.png)"/></svg>',
            "no svg here",
        ):
            with self.assertRaises(ValueError, msg=bad):
                pictures.check_svg(bad)

    def test_preview_grid_and_contact_sheet(self):
        p = pictures.path_of(self.pic, self.data)
        g = pictures.preview([p], True, [[10, 10, 100, 100]], [[20, 20, 40, 40]], self.data)
        self.assertEqual((g["size"], g["gridStep"]), ([400, 300], 50))
        im = Image.open(self.data / g["file"]).convert("RGB")
        r, gr, b = im.getpixel((60, 10))
        self.assertGreater(r, 150, "the edit box is drawn in red")
        sheet = pictures.preview([p, p, p], data=self.data)
        self.assertTrue(sheet["file"].endswith("contact-sheet.jpg"))
        with self.assertRaises(ValueError):
            pictures.preview([p], boxes=[[500, 500, 600, 600]], data=self.data)

    def test_composite_and_convert(self):
        src = pictures.add(png(100, 100, (0, 255, 0)), "src.png", self.data)["path"]
        out = pictures.composite(pictures.path_of(self.pic, self.data), pictures.path_of(src, self.data), [0, 0, 50, 100], [20, 20], 1.0, 0, False, "", self.data)
        im = Image.open(self.data / out["file"]).convert("RGB")
        self.assertEqual(im.getpixel((40, 60)), (0, 255, 0), "pasted where asked")
        self.assertEqual(im.getpixel((10, 10)), (30, 60, 200), "the rest is untouched")
        keyed = pictures.composite(pictures.path_of(self.pic, self.data), pictures.path_of(src, self.data), [0, 0, 100, 100], [0, 0], 1.0, 0, False, "#00ff00", self.data)
        self.assertEqual(Image.open(self.data / keyed["file"]).convert("RGB").getpixel((25, 50)), (30, 60, 200), "the keyed colour is see-through")
        for to, ext in (("jpg", ".jpg"), ("webp", ".webp"), ("pdf", ".pdf"), ("tiff", ".tiff")):
            self.assertTrue(pictures.convert(pictures.path_of(self.pic, self.data), to, self.data)["file"].endswith(ext))
        with self.assertRaises(ValueError):
            pictures.convert(pictures.path_of(self.pic, self.data), "exe", self.data)

    def test_trash_moves_finished_files_only(self):
        out = pictures.convert(pictures.path_of(self.pic, self.data), "jpg", self.data)["file"]
        went = pictures.trash(out, self.data)
        self.assertTrue(went.startswith(".trash/") and went.endswith(out))
        self.assertTrue((self.data / went).exists())
        self.assertFalse((self.data / out).exists())
        self.assertFalse((self.data / out).parent.exists(), "the emptied output folder goes too")
        (self.data / "library" / "abcdefabcdef").mkdir(parents=True)
        (self.data / "library" / "abcdefabcdef" / "original.wav").write_bytes(b"x")
        for bad in ("library/abcdefabcdef/original.wav", "jobs.json", "../x", went):
            with self.assertRaises(ValueError, msg=bad):
                pictures.trash(bad, self.data)


class PictureJobTests(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp())
        self.lib = Library(self.data)
        self.jobs = Jobs(self.data)
        self.fake = FakeComfy()
        self.w = Worker(self.lib, self.jobs, Comfy(self.fake.url), None, self.data)
        self.pic = pictures.add(png(), "cover.png", self.data)["path"]

    def run_job(self, kind, **params):
        err = check_params(kind, params, self.lib)
        self.assertIsNone(err, err)
        job = self.jobs.add(kind, params, kind)
        self.w.run(job)
        return self.jobs.get(job["id"])

    def test_workflows(self):
        up = upscale_workflow("mc/x.png", "RealESRGAN_x4plus.pth", "p")
        self.assertEqual([up[k]["class_type"] for k in "1234"], ["LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "SaveImage"])
        ed = edit_workflow("mc/i.png", "mc/m.png", "a clear sky", 5, 0.9, "p", "z.safetensors", "q.safetensors", "ae.safetensors")
        self.assertEqual(ed["10"]["class_type"], "SetLatentNoiseMask")
        self.assertEqual(ed["8"]["inputs"]["channel"], "red")
        self.assertEqual(ed["11"]["inputs"]["denoise"], 0.9)

    def test_upscale(self):
        j = self.run_job("upscale", picture=self.pic)
        self.assertEqual(j["status"], "done", j.get("error"))
        self.assertIn("RealESRGAN_x4plus.pth", j["result"]["message"])
        self.assertEqual(self.fake.prompts[-1]["2"]["inputs"]["model_name"], "RealESRGAN_x4plus.pth")
        self.assertTrue((self.data / j["result"]["files"][0]).exists())
        self.fake.upscale = False
        j = self.run_job("upscale", picture=self.pic)
        self.assertEqual(j["status"], "failed")
        self.assertIn("RealESRGAN_x4plus.pth", j["error"], "says which model to download")

    def test_edit_changes_only_the_boxes(self):
        self.assertEqual(check_params("edit", {"picture": self.pic, "prompt": "x", "boxes": [[900, 900, 950, 950]]}, self.lib)[:7], "The box")
        self.assertEqual(check_params("edit", {"picture": self.pic, "prompt": "", "boxes": [[0, 0, 9, 9]]}, self.lib), "Describe what the boxes should show instead")
        j = self.run_job("edit", picture=self.pic, prompt="a calm blue sky", boxes=[[0, 0, 150, 150]], keep=[[0, 0, 30, 30]])
        self.assertEqual(j["status"], "done", j.get("error"))
        wf = self.fake.prompts[-1]
        self.assertEqual(wf["8"]["class_type"], "LoadImageMask")
        self.assertGreaterEqual(len(self.fake.uploads), 2, "the picture and its mask go to ComfyUI")
        out = Image.open(self.data / j["result"]["files"][0]).convert("RGB")
        self.assertEqual(out.size, (400, 300))
        self.assertEqual(out.getpixel((10, 10)), (30, 60, 200), "a keep box stays as it was")
        self.assertEqual(out.getpixel((380, 280)), (220, 40, 40), "outside the boxes stays as it was")
        self.assertNotEqual(out.getpixel((100, 100)), (30, 60, 200), "inside the box was repainted")


class SharedFolderTests(unittest.TestCase):
    def test_find_and_resolve_across_folders(self):
        import os

        music, pics = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        (music / "beat.mp3").write_bytes(b"x")
        (pics / "Album Art.png").write_bytes(png())
        old = imports.IMPORT_DIR
        imports.IMPORT_DIR = music
        os.environ.update(PICTURES_IMPORT_DIR=str(pics), PICTURES_HOST_DIR="C:\\Users\\aldra\\Pictures", DOWNLOADS_IMPORT_DIR="/nonexistent")
        try:
            self.assertEqual([r[0] for r in imports.roots()], ["music", "pictures"])
            self.assertEqual([(f["folder"], f["path"]) for f in imports.find_any("album", imports.IMAGES)], [("pictures", "Album Art.png")])
            self.assertEqual(imports.resolve_any("C:\\Users\\aldra\\Pictures\\Album Art.png", imports.IMAGES), pics / "Album Art.png")
            self.assertEqual(imports.resolve_any("beat.mp3", imports.AUDIO), music / "beat.mp3")
            with self.assertRaises(ValueError):
                imports.resolve_any("beat.mp3", imports.IMAGES)
        finally:
            imports.IMPORT_DIR = old
            for k in ("PICTURES_IMPORT_DIR", "PICTURES_HOST_DIR", "DOWNLOADS_IMPORT_DIR"):
                os.environ.pop(k, None)


if __name__ == "__main__":
    unittest.main()
