"""Pictures in the studio: add them (uploads, the shared Pictures/Downloads folders, finished
work), then put real text on them, render SVG designs, look at them with a grid, paste one into
another, convert them, and (on the graphics card, see worker.py) upscale and repaint parts.

  pictures/<name>.<ext>                 pictures you added
  outputs/pictures/<name>-<id>/...      what the picture tools made

A picture is named by its path under the data folder (pictures/cover.png or
outputs/pictures/x-1a2b3c/x.png); nothing outside pictures/ and outputs/ can be used.
"""

from __future__ import annotations

import base64
import html
import io
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from .store import DATA, slug

EXTS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp", ".gif"}
# What convert() can write
FORMATS = {"png": "PNG", "jpg": "JPEG", "webp": "WEBP", "tiff": "TIFF", "pdf": "PDF"}
MAX_PIXELS = 80_000_000  # about 9000 x 9000; refuses decompression bombs
MAX_SVG = 2_000_000


class PictureError(ValueError):
    pass


def _image():
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    return Image


def library(data: Path | None = None) -> Path:
    d = (data or DATA) / "pictures"
    d.mkdir(parents=True, exist_ok=True)
    return d


def out_dir(name: str, data: Path | None = None) -> Path:
    d = (data or DATA) / "outputs" / "pictures" / f"{slug(name)}-{secrets.token_hex(3)}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def path_of(rel: str, data: Path | None = None) -> Path:
    """A picture under pictures/ or outputs/, by its path in the data folder."""
    root = (data or DATA).resolve()
    rel = str(rel or "").strip().lstrip("/")
    if not rel:
        raise PictureError("Say which picture")
    target = (root / rel).resolve()
    allowed = [(root / "pictures").resolve(), (root / "outputs").resolve()]
    if not any(a in target.parents for a in allowed) or not target.is_file() or target.suffix.lower() not in EXTS:
        raise PictureError(f"No picture {rel} in the studio (list them first)")
    return target


def rel(p: Path, data: Path | None = None) -> str:
    return str(p.resolve().relative_to((data or DATA).resolve()))


def open_image(p: Path):
    Image = _image()
    try:
        im = Image.open(p)
        im.load()
    except Image.DecompressionBombError as e:
        raise PictureError("That picture is too large") from e
    except OSError as e:
        raise PictureError(f"Couldn't read {p.name} as a picture") from e
    return im


def info(p: Path, data: Path | None = None) -> dict:
    try:
        Image = _image()
        with Image.open(p) as im:
            w, h = im.size
    except Exception:  # noqa: BLE001
        w = h = 0
    st = p.stat()
    return {"path": rel(p, data), "name": p.name, "width": w, "height": h, "sizeMB": round(st.st_size / 1048576, 2), "at": int(st.st_mtime * 1000)}


def list_all(data: Path | None = None, limit: int = 300) -> list[dict]:
    """Added pictures and the picture tools' results, newest first."""
    data = data or DATA
    found = [p for p in library(data).rglob("*") if p.is_file() and p.suffix.lower() in EXTS]
    outs = data / "outputs"
    if outs.exists():
        found += [p for p in outs.rglob("*") if p.is_file() and p.suffix.lower() in EXTS and "/.trash/" not in str(p)]
    found.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [info(p, data) for p in found[:limit]]


def preview_b64(p: Path, max_side: int = 1280) -> str:
    """A JPEG preview (for the card and the page), base64."""
    im = open_image(p)
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    _flatten(im).save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def _flatten(im):
    """RGB on white (for JPEG and PDF), keeping RGB pictures as they are."""
    Image = _image()
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, "white")
        bg.paste(im, mask=im.split()[-1])
        return bg
    return im.convert("RGB") if im.mode != "RGB" else im


def result(p: Path, data: Path | None = None) -> dict:
    return {**info(p, data), "file": rel(p, data), "preview": preview_b64(p)}


# --- adding pictures ---------------------------------------------------------------

def _unique(dirpath: Path, stem: str, ext: str) -> Path:
    p = dirpath / f"{slug(stem, 'picture')}{ext}"
    i = 2
    while p.exists():
        p = dirpath / f"{slug(stem, 'picture')}-{i}{ext}"
        i += 1
    return p


def add(raw: bytes, filename: str, data: Path | None = None) -> dict:
    """Saves a picture in pictures/. PNG/JPEG/WebP stay as they are; anything else (TIFF, BMP, GIF,
    PSD, SVG, PDF) becomes a PNG."""
    if not raw:
        raise PictureError("The file is empty")
    ext = Path(filename).suffix.lower()
    stem = Path(filename).stem or "picture"
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / f"in{ext or '.bin'}"
        src.write_bytes(raw)
        if ext in (".svg", ".pdf"):
            png = Path(tmp) / "out.png"
            if ext == ".svg":
                check_svg(raw.decode("utf-8", "replace"))
            _inkscape(src, png, dpi=150 if ext == ".pdf" else None)
            src, ext = png, ".png"
        im = open_image(src)
        dst = _unique(library(data), stem, ext if ext in (".png", ".jpg", ".jpeg", ".webp") else ".png")
        if dst.suffix == src.suffix and ext in (".png", ".jpg", ".jpeg", ".webp"):
            shutil.copyfile(src, dst)
        else:
            (im.convert("RGBA") if im.mode in ("P", "LA") else im).save(dst)
    return info(dst, data)


def import_from(src: Path, data: Path | None = None) -> dict:
    """A picture from a shared folder on the PC."""
    if src.stat().st_size > 200 * 1024 * 1024:
        raise PictureError("Pictures can be at most 200 MB")
    return add(src.read_bytes(), src.name, data)


# --- text on a picture and SVG designs (Inkscape) ----------------------------------

POSITIONS = {
    "top": ("middle", 0.5, 0.12), "center": ("middle", 0.5, 0.5), "bottom": ("middle", 0.5, 0.84),
    "top-left": ("start", 0.06, 0.12), "top-right": ("end", 0.94, 0.12),
    "bottom-left": ("start", 0.06, 0.84), "bottom-right": ("end", 0.94, 0.84),
}
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def _inkscape(src: Path, dst: Path, width: int | None = None, dpi: int | None = None) -> Path:
    if not shutil.which("inkscape"):
        raise PictureError("Inkscape isn't installed in the studio")
    kind = dst.suffix.lstrip(".")
    cmd = ["inkscape", str(src), f"--export-type={kind}", f"--export-filename={dst}"]
    if width and kind == "png":
        cmd.append(f"--export-width={int(width)}")
    if dpi:
        cmd.append(f"--export-dpi={int(dpi)}")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0 or not dst.exists():
        raise PictureError(f"Inkscape couldn't render it: {(r.stderr or '').strip()[-300:]}")
    return dst


def check_svg(svg: str) -> None:
    """Only self-contained SVG: no scripts, no entities, no links to files or the web."""
    if len(svg) > MAX_SVG:
        raise PictureError("That SVG is too large")
    low = svg.lower()
    if "<svg" not in low:
        raise PictureError("That isn't an SVG (it needs an <svg> element)")
    for bad in ("<!entity", "<!doctype", "<script", "<foreignobject", "javascript:", "<?xml-stylesheet"):
        if bad in low:
            raise PictureError(f"SVGs can't contain {bad.strip('<')} here")
    for m in re.finditer(r"""(?:xlink:)?href\s*=\s*["']([^"']*)["']""", svg, re.I):
        if not (m.group(1).startswith("#") or m.group(1).startswith("data:image/")):
            raise PictureError("Links in an SVG can only point inside it (#id) or be embedded data:image/... pictures")
    if re.search(r"url\(\s*['\"]?(?!#)", svg, re.I) or "@import" in low:
        raise PictureError("Styles in an SVG can only refer to things inside it (url(#id))")


def text_on(picture: Path, title: str, subtitle: str = "", position: str = "bottom", color: str = "#ffffff", size: int = 0, shadow: bool = True, data: Path | None = None) -> dict:
    """Sharp text on a picture (Inkscape, Inter): a title and an optional subtitle or credit."""
    title = title.strip()[:200]
    if not title:
        raise PictureError("Write the text to put on the picture")
    im = open_image(picture)
    w, h = im.size
    anchor, fx, fy = POSITIONS.get(position, POSITIONS["bottom"])
    color = color if COLOR.match(color or "") else "#ffffff"
    t_size = int(size) if size and 8 <= int(size) <= 1000 else max(18, round(min(w, h) * (0.09 if len(title) < 24 else 0.06)))
    s_size = max(12, round(t_size * 0.42))
    x, y = fx * w, fy * h
    lines = [line for line in title.split("\n") if line.strip()][:4]
    if fy > 0.7:  # grow upwards from the bottom
        y -= (len(lines) - 1) * t_size * 1.1 + (s_size * 1.5 if subtitle else 0)
    elif fy > 0.3:
        y -= ((len(lines) - 1) * t_size * 1.1 + (s_size * 1.5 if subtitle else 0)) / 2
    # A soft dark shadow (SVG 1.1 filters: Inkscape doesn't draw feDropShadow)
    shade = (
        '<filter id="sh" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="3"/>'
        '<feOffset dx="0" dy="2" result="b"/><feComponentTransfer><feFuncA type="linear" slope="0.7"/></feComponentTransfer>'
        '<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
        if shadow
        else ""
    )
    style = f"font-family:Inter,'DejaVu Sans',sans-serif;text-anchor:{anchor};fill:{color}"
    texts = "".join(
        f'<text x="{x:.1f}" y="{y + i * t_size * 1.1:.1f}" style="{style};font-size:{t_size}px;font-weight:800"{" filter=\"url(#sh)\"" if shadow else ""}>{html.escape(line)}</text>'
        for i, line in enumerate(lines)
    )
    if subtitle.strip():
        texts += f'<text x="{x:.1f}" y="{y + (len(lines) - 1) * t_size * 1.1 + s_size * 1.6:.1f}" style="{style};font-size:{s_size}px;font-weight:500;letter-spacing:0.04em"{" filter=\"url(#sh)\"" if shadow else ""}>{html.escape(subtitle.strip()[:200])}</text>'
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp) / "base.png"
        im.convert("RGBA").save(base)
        svg = Path(tmp) / "t.svg"
        svg.write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
            f"<defs>{shade}</defs><image x=\"0\" y=\"0\" width=\"{w}\" height=\"{h}\" xlink:href=\"{base.as_uri()}\"/>{texts}</svg>"
        )
        d = out_dir(f"{picture.stem}-text", data)
        dst = d / f"{slug(picture.stem)}-text.png"
        _inkscape(svg, dst, width=w)
    return result(dst, data)


def render_svg(svg: str, title: str = "design", fmt: str = "png", width: int = 0, data: Path | None = None) -> dict:
    """An SVG design (title card, poster, cover layout) as a PNG or PDF."""
    check_svg(svg)
    fmt = "pdf" if fmt == "pdf" else "png"
    d = out_dir(title or "design", data)
    src = d / f"{slug(title or 'design')}.svg"
    src.write_text(svg)
    dst = _inkscape(src, src.with_suffix(f".{fmt}"), width=max(0, min(8000, int(width or 0))) or None)
    if fmt == "png":
        return result(dst, data)
    return {"file": rel(dst, data), "svg": rel(src, data), "name": dst.name}


# --- looking at pictures -----------------------------------------------------------

def _font(size: int):
    from PIL import ImageFont

    for f in ("/usr/share/fonts/opentype/inter/Inter-Bold.otf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def clean_box(b, w: int, h: int) -> tuple[int, int, int, int]:
    """[x0, y0, x1, y1] in pixels, inside the picture, at least 2 px each way."""
    try:
        x0, y0, x1, y1 = (int(round(float(v))) for v in list(b)[:4])
    except (TypeError, ValueError) as e:
        raise PictureError("A box is [x0, y0, x1, y1] in pixels") from e
    x0, x1 = sorted((max(0, min(w, x0)), max(0, min(w, x1))))
    y0, y1 = sorted((max(0, min(h, y0)), max(0, min(h, y1))))
    if x1 - x0 < 2 or y1 - y0 < 2:
        raise PictureError(f"The box {list(b)} is outside the picture ({w}x{h}) or too small")
    return x0, y0, x1, y1


def preview(pictures: list[Path], grid: bool = True, boxes: list | None = None, keep: list | None = None, data: Path | None = None) -> dict:
    """One picture with a labelled pixel grid (edit boxes red, keep boxes green), or a contact
    sheet of several, numbered."""
    Image = _image()
    from PIL import ImageDraw

    if not pictures:
        raise PictureError("Say which pictures")
    d = out_dir("preview", data)
    if len(pictures) == 1:
        im = _flatten(open_image(pictures[0]))
        w, h = im.size
        draw = ImageDraw.Draw(im, "RGBA")
        if grid:
            step = next(s for s in (50, 100, 200, 250, 500, 1000, 2000) if max(w, h) / s <= 12)
            f = _font(max(11, min(w, h) // 60))
            for x in range(step, w, step):
                draw.line([(x, 0), (x, h)], fill=(255, 255, 0, 110), width=1)
                draw.text((x + 3, 3), str(x), fill=(255, 255, 0, 230), font=f, stroke_width=2, stroke_fill=(0, 0, 0, 200))
            for y in range(step, h, step):
                draw.line([(0, y), (w, y)], fill=(255, 255, 0, 110), width=1)
                draw.text((3, y + 3), str(y), fill=(255, 255, 0, 230), font=f, stroke_width=2, stroke_fill=(0, 0, 0, 200))
        for color, group in (((255, 40, 40), boxes or []), ((40, 220, 90), keep or [])):
            for b in group:
                x0, y0, x1, y1 = clean_box(b, w, h)
                draw.rectangle([x0, y0, x1, y1], outline=color + (255,), width=max(2, min(w, h) // 300), fill=color + (40,))
        dst = d / f"{slug(pictures[0].stem)}-grid.jpg"
        im.save(dst, "JPEG", quality=88)
        return {**result(dst, data), "size": [w, h], "gridStep": step if grid else None}
    cols = 3 if len(pictures) > 4 else 2
    cell = 420
    rows = (len(pictures[:12]) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 30)), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)
    f = _font(16)
    for i, p in enumerate(pictures[:12]):
        im = _flatten(open_image(p))
        size = im.size
        im.thumbnail((cell - 16, cell - 16))
        x, y = (i % cols) * cell, (i // cols) * (cell + 30)
        sheet.paste(im, (x + (cell - im.width) // 2, y + 8 + (cell - 16 - im.height) // 2))
        draw.text((x + 8, y + cell + 4), f"{i + 1}. {p.name[:38]} ({size[0]}x{size[1]})", fill=(230, 230, 230), font=f)
    dst = d / "contact-sheet.jpg"
    sheet.save(dst, "JPEG", quality=88)
    return result(dst, data)


# --- pasting, converting -----------------------------------------------------------

def composite(base: Path, source: Path, source_box: list, at: list, scale: float = 1.0, feather: int = 12, match: bool = True, key: str = "", data: Path | None = None) -> dict:
    """Pastes the source_box part of `source` into `base` with its top-left corner at `at`:
    optionally scaled, colour-matched to where it lands, keyed (a plain background made see-
    through: "white", "black" or "#rrggbb") and with feathered edges."""
    Image = _image()
    from PIL import ImageChops, ImageFilter, ImageStat

    b = open_image(base).convert("RGBA")
    s = open_image(source).convert("RGBA")
    piece = s.crop(clean_box(source_box, *s.size))
    scale = max(0.05, min(8.0, float(scale or 1)))
    if abs(scale - 1) > 1e-3:
        piece = piece.resize((max(2, round(piece.width * scale)), max(2, round(piece.height * scale))), Image.LANCZOS)
    try:
        x, y = (int(round(float(v))) for v in list(at)[:2])
    except (TypeError, ValueError) as e:
        raise PictureError("at is [x, y] in pixels on the base picture") from e
    if key:
        target = {"white": (255, 255, 255), "black": (0, 0, 0)}.get(key) or (tuple(int(key[i : i + 2], 16) for i in (1, 3, 5)) if COLOR.match(key) else None)
        if target is None:
            raise PictureError('key is "white", "black" or a #rrggbb colour')
        diff = ImageChops.difference(piece.convert("RGB"), Image.new("RGB", piece.size, target)).convert("L")
        alpha = diff.point(lambda v: 0 if v < 28 else min(255, (v - 28) * 6))
        piece.putalpha(ImageChops.multiply(piece.getchannel("A"), alpha))
    if match:
        region = b.crop((max(0, x), max(0, y), min(b.width, x + piece.width), min(b.height, y + piece.height))).convert("RGB")
        if region.width > 4 and region.height > 4:
            ps, rs = ImageStat.Stat(piece.convert("RGB"), piece.getchannel("A")), ImageStat.Stat(region)
            bands = []
            for i, band in enumerate(piece.convert("RGB").split()):
                gain = (rs.stddev[i] + 1) / (ps.stddev[i] + 1)
                gain = max(0.6, min(1.6, gain))
                shift = rs.mean[i] - ps.mean[i] * gain
                # Half way: keeps the object's own colour while it settles into the light around it
                bands.append(band.point(lambda v, g=gain, o=shift: max(0, min(255, round(v + ((v * g + o) - v) * 0.5)))))
            piece = Image.merge("RGBA", (*bands, piece.getchannel("A")))
    feather = max(0, min(200, int(feather or 0)))
    if feather:
        edge = Image.new("L", piece.size, 0)
        inner = Image.new("L", (max(1, piece.width - 2 * feather), max(1, piece.height - 2 * feather)), 255)
        edge.paste(inner, (feather, feather))
        edge = edge.filter(ImageFilter.GaussianBlur(feather / 2))
        piece.putalpha(ImageChops.multiply(piece.getchannel("A"), edge))
    b.alpha_composite(piece, (x, y)) if x >= 0 and y >= 0 else b.paste(piece, (x, y), piece)
    d = out_dir(f"{base.stem}-composite", data)
    dst = d / f"{slug(base.stem)}-composite.png"
    (b if base.suffix.lower() == ".png" else b.convert("RGB")).save(dst)
    return result(dst, data)


def convert(picture: Path, to: str, data: Path | None = None, max_side: int = 0) -> dict:
    to = {"jpeg": "jpg", "tif": "tiff"}.get(to.lower().lstrip("."), to.lower().lstrip("."))
    if to not in FORMATS:
        raise PictureError(f"Convert to one of {', '.join(FORMATS)}")
    im = open_image(picture)
    if max_side and max(im.size) > max_side:
        im.thumbnail((int(max_side), int(max_side)), _image().LANCZOS)
    d = out_dir(f"{picture.stem}-{to}", data)
    dst = d / f"{slug(picture.stem)}.{to}"
    if to in ("jpg", "pdf"):
        _flatten(im).save(dst, FORMATS[to], **({"quality": 92} if to == "jpg" else {"resolution": 300.0}))
    else:
        (im.convert("RGBA") if im.mode in ("P", "LA") else im).save(dst, FORMATS[to])
    return {**info(dst, data), "file": rel(dst, data)} if to == "pdf" else result(dst, data)


# --- for the graphics-card jobs ------------------------------------------------------

def fit16(im, max_side: int = 1536):
    """A copy whose sides are multiples of 16 and at most max_side (what Z-Image draws)."""
    Image = _image()
    w, h = im.size
    k = min(1.0, max_side / max(w, h))
    nw, nh = max(64, int(w * k) // 16 * 16), max(64, int(h * k) // 16 * 16)
    return im.resize((nw, nh), Image.LANCZOS) if (nw, nh) != (w, h) else im.copy()


def mask_for(size: tuple[int, int], boxes: list, keep: list | None = None, feather: int = 0):
    """White where the picture is repainted (the boxes, minus the keep boxes), black elsewhere."""
    Image = _image()
    from PIL import ImageDraw, ImageFilter

    m = Image.new("L", size, 0)
    draw = ImageDraw.Draw(m)
    for b in boxes:
        draw.rectangle(clean_box(b, *size), fill=255)
    for b in keep or []:
        draw.rectangle(clean_box(b, *size), fill=0)
    if feather:
        m = m.filter(ImageFilter.GaussianBlur(feather))
    return m


def trash(rel_path: str, data: Path | None = None) -> str:
    """Moves one finished file (under outputs/ or pictures/) to .trash/<time>/ in the data folder,
    so it can be put back. Returns where it went."""
    data = data or DATA
    root = data.resolve()
    target = (root / str(rel_path or "").lstrip("/")).resolve()
    allowed = [(root / "outputs").resolve(), (root / "pictures").resolve()]
    if not any(a in target.parents for a in allowed) or not target.is_file() or "/.trash/" in str(target):
        raise PictureError("Only finished files (outputs and pictures) can be moved to the trash")
    dst = root / ".trash" / time.strftime("%Y%m%d-%H%M%S") / target.relative_to(root)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(target), str(dst))
    # An emptied output folder goes too (it would show as nothing in the list)
    folder = target.parent
    if folder.parent.parent == root / "outputs" and not any(folder.iterdir()):
        folder.rmdir()
    return str(dst.relative_to(root))
