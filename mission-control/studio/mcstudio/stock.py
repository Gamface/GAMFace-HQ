"""Real photos and video clips for themed music videos, from Pexels and Pixabay (free to use;
each needs a free API key: PEXELS_API_KEY, PIXABAY_API_KEY). Every item keeps its credit
(photographer and page), written to credits.txt next to the video."""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

PEXELS_API = os.environ.get("PEXELS_API_URL", "https://api.pexels.com")
PIXABAY_API = os.environ.get("PIXABAY_API_URL", "https://pixabay.com/api")
MAX_CLIP_BYTES = 120 * 1024 * 1024
MAX_PHOTO_BYTES = 25 * 1024 * 1024
UA = "MissionControlStudio/1.0"


@dataclass
class Item:
    kind: str  # "video" | "photo"
    url: str  # the file to download
    page: str  # where it lives on the site
    credit: str  # "Name on Pexels"
    source: str  # "pexels" | "pixabay"
    query: str
    width: int = 0
    height: int = 0
    duration: float = 0.0
    extra: dict = field(default_factory=dict)


def keys() -> dict[str, bool]:
    return {"pexels": bool(os.environ.get("PEXELS_API_KEY")), "pixabay": bool(os.environ.get("PIXABAY_API_KEY"))}


def _get(url: str, headers: dict | None = None, timeout: float = 20) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise RuntimeError(f"{urllib.parse.urlparse(url).hostname} refused the API key ({e.code}): check it in .env") from e
        raise RuntimeError(f"{urllib.parse.urlparse(url).hostname} answered {e.code}") from e
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        raise RuntimeError(f"Couldn't reach {urllib.parse.urlparse(url).hostname}: {e}") from e


def orientation(aspect: str) -> dict[str, str]:
    return {"16:9": {"pexels": "landscape", "pixabay": "horizontal"}, "9:16": {"pexels": "portrait", "pixabay": "vertical"}}.get(aspect, {"pexels": "square", "pixabay": "all"})


def _best_file(files: list[dict], target: int) -> dict | None:
    """The MP4 whose short side is closest to (and preferably at least) `target` pixels."""
    mp4 = [f for f in files if str(f.get("file_type", "video/mp4")).endswith("mp4") and f.get("link") and f.get("width") and f.get("height")]
    if not mp4:
        return None
    return min(mp4, key=lambda f: (min(f["width"], f["height"]) < target, abs(min(f["width"], f["height"]) - target)))


def pexels(query: str, kind: str, aspect: str, count: int, target: int = 1080) -> list[Item]:
    key = os.environ.get("PEXELS_API_KEY", "")
    if not key:
        return []
    q = urllib.parse.urlencode({"query": query, "per_page": min(40, max(1, count)), "orientation": orientation(aspect)["pexels"]})
    if kind == "video":
        data = _get(f"{PEXELS_API}/videos/search?{q}", {"Authorization": key})
        out = []
        for v in data.get("videos", []):
            f = _best_file(v.get("video_files", []), target)
            if f:
                out.append(Item("video", f["link"], v.get("url", ""), f"{(v.get('user') or {}).get('name', 'Unknown')} on Pexels", "pexels", query, f["width"], f["height"], float(v.get("duration") or 0)))
        return out
    data = _get(f"{PEXELS_API}/v1/search?{q}", {"Authorization": key})
    return [
        Item("photo", (p.get("src") or {}).get("large2x") or (p.get("src") or {}).get("original", ""), p.get("url", ""), f"{p.get('photographer', 'Unknown')} on Pexels", "pexels", query, int(p.get("width") or 0), int(p.get("height") or 0))
        for p in data.get("photos", [])
        if (p.get("src") or {}).get("large2x") or (p.get("src") or {}).get("original")
    ]


def pixabay(query: str, kind: str, aspect: str, count: int) -> list[Item]:
    key = os.environ.get("PIXABAY_API_KEY", "")
    if not key:
        return []
    params = {"key": key, "q": query[:100], "per_page": min(50, max(3, count)), "safesearch": "true"}
    if kind == "video":
        data = _get(f"{PIXABAY_API}/videos/?{urllib.parse.urlencode(params)}")
        out = []
        for h in data.get("hits", []):
            vids = h.get("videos") or {}
            f = vids.get("large") if (vids.get("large") or {}).get("url") else vids.get("medium")
            if f and f.get("url"):
                out.append(Item("video", f["url"], h.get("pageURL", ""), f"{h.get('user', 'Unknown')} on Pixabay", "pixabay", query, int(f.get("width") or 0), int(f.get("height") or 0), float(h.get("duration") or 0)))
        return out
    params.update(image_type="photo", orientation=orientation(aspect)["pixabay"])
    data = _get(f"{PIXABAY_API}/?{urllib.parse.urlencode(params)}")
    return [
        Item("photo", h.get("largeImageURL") or h.get("webformatURL", ""), h.get("pageURL", ""), f"{h.get('user', 'Unknown')} on Pixabay", "pixabay", query, int(h.get("imageWidth") or 0), int(h.get("imageHeight") or 0))
        for h in data.get("hits", [])
        if h.get("largeImageURL") or h.get("webformatURL")
    ]


def queries(theme: str, limit: int = 6) -> list[str]:
    """Search phrases from a theme: comma or line separated parts, or the theme itself."""
    parts = [p.strip() for p in re.split(r"[,\n;]+", theme) if p.strip()]
    return (parts or [theme.strip()])[:limit]


def find(theme: str, aspect: str, count: int, want_videos: float = 0.6, notes: list[str] | None = None) -> list[Item]:
    """About `count` items for the theme, spread over its search phrases, about `want_videos`
    of them video clips, alternating sources. Items without a key are skipped quietly."""
    qs = queries(theme)
    per = max(2, -(-count // len(qs)))
    pools: list[list[Item]] = []
    for q in qs:
        found: list[Item] = []
        for source in (pexels, pixabay):
            for kind in ("video", "photo"):
                try:
                    found += source(q, kind, aspect, per * 2)
                except RuntimeError as e:
                    if notes is not None and str(e) not in notes:
                        notes.append(str(e))
        pools.append(found)
    # Take videos and photos in the asked-for ratio, round-robin over the phrases
    picked: list[Item] = []
    seen: set[str] = set()
    n_videos = round(count * want_videos)
    for kind, n in (("video", n_videos), ("photo", count - n_videos)):
        got = 0
        rnd = 0
        while got < n and any(any(i.kind == kind and i.url not in seen for i in p) for p in pools):
            for p in pools:
                cand = [i for i in p if i.kind == kind and i.url not in seen]
                if cand and got < n:
                    # Favour clips long enough to cut from, and skip tiny files
                    cand.sort(key=lambda i: (i.kind == "video" and i.duration < 4, -min(i.width, i.height)))
                    picked.append(cand[0])
                    seen.add(cand[0].url)
                    got += 1
            rnd += 1
            if rnd > count * 4:
                break
    # Not enough of one kind: fill with the other
    if len(picked) < count:
        rest = [i for p in pools for i in p if i.url not in seen]
        picked += rest[: count - len(picked)]
    return picked


def download(item: Item, dest_dir: Path, n: int) -> Path:
    """Saves one item; its URL must be https on the site it came from."""
    host = urllib.parse.urlparse(item.url).hostname or ""
    if not item.url.startswith("https://") and not os.environ.get("STOCK_ALLOW_HTTP"):
        raise RuntimeError(f"Refusing a non-https download from {host}")
    ext = ".mp4" if item.kind == "video" else (".png" if item.url.lower().split("?")[0].endswith(".png") else ".jpg")
    dest = dest_dir / f"{n:02d}-{item.source}-{re.sub(r'[^a-z0-9]+', '-', item.query.lower()).strip('-')[:30]}{ext}"
    limit = MAX_CLIP_BYTES if item.kind == "video" else MAX_PHOTO_BYTES
    req = urllib.request.Request(item.url, headers={"User-Agent": UA})
    dest_dir.mkdir(parents=True, exist_ok=True)
    size = 0
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                f.close()
                dest.unlink(missing_ok=True)
                raise RuntimeError(f"{item.page or item.url} is too large")
            f.write(chunk)
    return dest


def credits(items: list[tuple[Item, Path]], ai: list[str]) -> str:
    lines = ["Footage in this video", ""]
    for it, p in items:
        lines.append(f"{p.name}: {it.kind} by {it.credit} ({it.page})")
    if any(it.source == "pexels" for it, _ in items):
        lines += ["", "Photos and videos provided by Pexels (https://www.pexels.com). Free to use; crediting the creators is appreciated."]
    if any(it.source == "pixabay" for it, _ in items):
        lines += ["", "Images and videos from Pixabay (https://pixabay.com), under the Pixabay Content License."]
    if ai:
        lines += ["", "AI-made pictures (ComfyUI, Z-Image Turbo):"] + [f"  {a}" for a in ai]
    return "\n".join(lines) + "\n"
