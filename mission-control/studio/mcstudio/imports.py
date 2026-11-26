"""Songs from a folder on the PC (your Music folder), mounted read-only at /import. Jarvis and the
Studio page can find a file there and add it to the library by the path you'd type on the PC:
  C:\\Users\\you\\Music\\Song.mp3     /mnt/c/Users/you/Music/Song.mp3     Song.mp3
IMPORT_HOST_DIR is the folder's path on the PC (MUSIC_DIR in .env), used to turn those paths
into paths under /import. Nothing outside the folder can be read."""

from __future__ import annotations

import os
import re
from pathlib import Path

IMPORT_DIR = Path(os.environ.get("IMPORT_DIR", "/import"))
AUDIO = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".aif", ".aiff", ".mp4", ".mov", ".webm", ".mkv"}
MAX_LIST = 200


def _norm(p: str) -> str:
    """One spelling for Windows and WSL paths: C:\\Users\\A → /mnt/c/users/a (lower case: Windows
    paths ignore case)."""
    p = p.strip().strip('"').strip("'").replace("\\", "/")
    m = re.match(r"^([A-Za-z]):/(.*)$", p)
    if m:
        p = f"/mnt/{m.group(1).lower()}/{m.group(2)}"
    p = re.sub(r"^//wsl(?:\$|\.localhost)/[^/]+", "", p, flags=re.I)
    return re.sub(r"/+", "/", p).rstrip("/").lower()


def available(root: Path | None = None) -> bool:
    root = root or IMPORT_DIR
    try:
        return root.is_dir() and any(True for _ in root.iterdir())
    except OSError:
        return False


def _inside(root: Path, target: Path) -> bool:
    try:
        return root.resolve() in target.resolve().parents
    except OSError:
        return False


def find(query: str = "", root: Path | None = None) -> list[dict]:
    """Audio and video files in the folder whose path contains every word of `query`."""
    root = root or IMPORT_DIR
    words = [w for w in re.split(r"[\s_\-.]+", query.lower()) if w]
    out: list[dict] = []
    for dirpath, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for f in sorted(files):
            p = Path(dirpath) / f
            if p.suffix.lower() not in AUDIO or f.startswith("."):
                continue
            if p.is_symlink() and not _inside(root, p):
                continue  # a link to somewhere outside the folder
            rel = str(p.relative_to(root))
            hay = rel.lower()
            if all(w in hay for w in words):
                try:
                    size = p.stat().st_size
                except OSError:
                    continue
                out.append({"path": rel, "name": f, "sizeMB": round(size / 1048576, 1)})
                if len(out) >= MAX_LIST:
                    return out
    return out


def resolve(path: str, root: Path | None = None, host_dir: str | None = None) -> Path:
    """The file under /import that a PC path (or a path inside the folder) names. Raises ValueError."""
    root = root or IMPORT_DIR
    host_dir = os.environ.get("IMPORT_HOST_DIR", "") if host_dir is None else host_dir
    if not available(root):
        raise ValueError("No music folder is shared with the studio yet: set MUSIC_DIR in mission-control/.env to your Music folder (for example /mnt/c/Users/you/Music) and run  docker compose up -d studio")
    raw = path.strip().strip('"').strip("'")
    if not raw:
        raise ValueError("Say which file")
    want = _norm(raw)
    candidates: list[str] = []
    host = _norm(host_dir) if host_dir else ""
    if host and (want == host or want.startswith(host + "/")):
        candidates.append(want[len(host):].lstrip("/"))
    if not want.startswith("/"):
        candidates.append(want)  # already relative to the folder
    for rel in candidates:
        hit = _match(root, rel)
        if hit:
            return hit
    # A path from somewhere else on the PC (or a different spelling of the folder): look for the
    # file by its last parts, the longest match first
    parts = [p for p in want.split("/") if p]
    for n in range(min(len(parts), 4), 0, -1):
        tail = "/".join(parts[-n:])
        hits = [f for f in find("", root) if f["path"].lower() == tail or f["path"].lower().endswith("/" + tail)]
        hit = _match(root, hits[0]["path"]) if len(hits) == 1 else None
        if hit:
            return hit
        if len(hits) > 1 and n == 1:
            raise ValueError(f"More than one file is called {parts[-1]}: {', '.join(h['path'] for h in hits[:5])}. Say which one.")
    raise ValueError(f"Couldn't find {raw} in the shared music folder. Find it with a search first, or check MUSIC_DIR in mission-control/.env.")


def _match(root: Path, rel: str) -> Path | None:
    """`rel` under root, matching names without regard to case (Windows doesn't care about case)."""
    cur = root
    for part in [p for p in rel.split("/") if p]:
        if part in (".", ".."):
            return None
        try:
            names = {c.name.lower(): c for c in cur.iterdir()}
        except OSError:
            return None
        nxt = names.get(part.lower())
        if nxt is None:
            return None
        cur = nxt
    if cur == root or not cur.is_file() or not _inside(root, cur) or cur.suffix.lower() not in AUDIO:
        return None
    return cur
