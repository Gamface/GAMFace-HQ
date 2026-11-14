"""Long-term memory: extract facts, recall them, and maintain them on a timer.

Every maintenance pass (default every 30 minutes):
  * decay   - unpinned memories lose importance the longer they go unused
  * forget  - memories that fall below a floor are deleted
  * merge   - near-duplicate memories are folded into one
Pinned memories never decay or get deleted.
"""
import difflib
import re
import time

from .config import Config

STOP = set("the a an and or but to of in on for with is are was were be it this that i you my me "
           "your we our can could would should do does did have has had at by from as so if not".split())
DECAY_PER_DAY = 0.85
FORGET_BELOW = 0.08
MERGE_SIMILARITY = 0.85


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOP and len(w) > 2}


class Memory:
    def __init__(self, db, llm):
        self.db = db
        self.llm = llm

    # ---- writing -----------------------------------------------------------
    def add(self, text: str, agent: str = "shared", importance: float = 0.5,
            pinned: bool = False) -> int | None:
        text = text.strip()
        if len(text) < 8:
            return None
        for row in self.db.all("SELECT id, text FROM memories WHERE agent=?", (agent,)):
            if difflib.SequenceMatcher(None, row["text"].lower(), text.lower()).ratio() >= MERGE_SIMILARITY:
                self.db.execute(
                    "UPDATE memories SET importance=MIN(1.0, importance+0.1), last_used=? WHERE id=?",
                    (time.time(), row["id"]),
                )
                return row["id"]
        now = time.time()
        cur = self.db.execute(
            "INSERT INTO memories (agent, text, importance, pinned, created_at, last_used)"
            " VALUES (?,?,?,?,?,?)",
            (agent, text, max(0.0, min(1.0, importance)), int(pinned), now, now),
        )
        return cur.lastrowid

    def extract(self, agent: str, prompt: str, answer: str) -> list[str]:
        """Ask the fast model which durable facts are worth keeping from one exchange."""
        data = self.llm.chat_json(Config.fast_model, [
            {"role": "system", "content": (
                "Extract durable facts worth remembering about the user, their projects, "
                "preferences, decisions or setup. Skip small talk and one-off details. "
                'Reply with JSON only: {"memories": [{"text": "...", "importance": 0.0-1.0, '
                '"shared": true|false}]} and an empty list if nothing is worth keeping.'
            )},
            {"role": "user", "content": f"USER: {prompt[:3000]}\n\nASSISTANT: {answer[:3000]}"},
        ])
        saved = []
        for item in data.get("memories", [])[:5] if isinstance(data.get("memories"), list) else []:
            if not isinstance(item, dict) or not item.get("text"):
                continue
            owner = "shared" if item.get("shared", True) else agent
            try:
                importance = float(item.get("importance", 0.5))
            except (TypeError, ValueError):
                importance = 0.5
            if self.add(str(item["text"]), owner, importance) is not None:
                saved.append(str(item["text"]))
        return saved

    # ---- reading -----------------------------------------------------------
    def recall(self, query: str, agent: str, limit: int = 6) -> list[str]:
        rows = self.db.all(
            "SELECT * FROM memories WHERE agent IN ('shared', ?)", (agent,)
        )
        q = _words(query)
        scored = []
        for r in rows:
            overlap = len(q & _words(r["text"]))
            score = overlap * 1.0 + r["importance"] + (2.0 if r["pinned"] else 0.0)
            if overlap or r["pinned"]:
                scored.append((score, r))
        scored.sort(key=lambda s: s[0], reverse=True)
        chosen = [r for _, r in scored[:limit]]
        now = time.time()
        for r in chosen:
            self.db.execute("UPDATE memories SET hits=hits+1, last_used=? WHERE id=?", (now, r["id"]))
        return [r["text"] for r in chosen]

    def list(self) -> list[dict]:
        return self.db.all("SELECT * FROM memories ORDER BY pinned DESC, importance DESC, id DESC")

    def pin(self, memory_id: int, pinned: bool = True) -> None:
        self.db.execute("UPDATE memories SET pinned=? WHERE id=?", (int(pinned), memory_id))

    def delete(self, memory_id: int) -> None:
        self.db.execute("DELETE FROM memories WHERE id=?", (memory_id,))

    # ---- maintenance -------------------------------------------------------
    def maintain(self, now: float | None = None) -> dict:
        now = now or time.time()
        decayed = forgotten = merged = 0
        rows = self.db.all("SELECT * FROM memories WHERE pinned=0")
        for r in rows:
            idle_days = max(0.0, (now - r["last_used"]) / 86400)
            new = r["importance"] * (DECAY_PER_DAY ** idle_days)
            if new < FORGET_BELOW:
                self.db.execute("DELETE FROM memories WHERE id=?", (r["id"],))
                forgotten += 1
            elif abs(new - r["importance"]) > 1e-4:
                # Reset last_used so decay is not applied twice for the same idle time.
                self.db.execute("UPDATE memories SET importance=?, last_used=? WHERE id=?",
                                (new, now, r["id"]))
                decayed += 1

        rows = self.db.all("SELECT * FROM memories ORDER BY pinned DESC, importance DESC")
        gone: set[int] = set()
        for i, a in enumerate(rows):
            if a["id"] in gone:
                continue
            for b in rows[i + 1:]:
                if b["id"] in gone or a["agent"] != b["agent"]:
                    continue
                if difflib.SequenceMatcher(None, a["text"].lower(), b["text"].lower()).ratio() >= MERGE_SIMILARITY:
                    keep, drop = (a, b) if a["pinned"] or a["importance"] >= b["importance"] else (b, a)
                    if drop["pinned"]:
                        continue
                    self.db.execute(
                        "UPDATE memories SET importance=MIN(1.0, ?), hits=hits+? WHERE id=?",
                        (max(keep["importance"], drop["importance"]) + 0.05, drop["hits"], keep["id"]),
                    )
                    self.db.execute("DELETE FROM memories WHERE id=?", (drop["id"],))
                    gone.add(drop["id"])
                    merged += 1
        return {"decayed": decayed, "forgotten": forgotten, "merged": merged}
