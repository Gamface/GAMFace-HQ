import type { JsonChat } from "./ollama";
import { JsonStore } from "./store";

// Long-term memory. After each task a small model pulls out durable facts.
// Every maintenance pass (default every 30 minutes) unpinned memories decay
// with disuse, faded ones are forgotten and near-duplicates are merged.
// Pinned memories never decay or get removed.

export interface MemoryItem {
  id: number;
  agent: string; // "shared" or an agent key
  text: string;
  importance: number;
  pinned: boolean;
  hits: number;
  createdAt: number;
  lastUsed: number;
}

interface MemoryData {
  nextId: number;
  items: MemoryItem[];
}

const DAY = 86_400_000;
export const DECAY_PER_DAY = 0.85;
export const FORGET_BELOW = 0.08;
export const MERGE_SIMILARITY = 0.85;
const STOP = new Set(
  "the a an and or but to of in on for with is are was were be it this that i you my me your we our can could would should do does did have has had at by from as so if not".split(" "),
);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
}

/** Character-bigram (Dice) similarity, 0..1. */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/\s+/g, " ").trim();
    const m = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const A = grams(a);
  const B = grams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of A) {
    overlap += Math.min(n, B.get(g) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total ? (2 * overlap) / total : 0;
}

export class Memory {
  private store: JsonStore<MemoryData>;
  private chat: JsonChat;
  private model: string;

  constructor(dataDir: string, chat: JsonChat, model: string) {
    this.store = new JsonStore<MemoryData>(dataDir, "memories.json", { nextId: 1, items: [] });
    this.chat = chat;
    this.model = model;
  }

  list(): MemoryItem[] {
    return [...this.store.data.items].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.id - a.id,
    );
  }

  add(text: string, agent = "shared", importance = 0.5, pinned = false): number | null {
    text = text.trim();
    if (text.length < 8) return null;
    const now = Date.now();
    const dup = this.store.data.items.find((m) => m.agent === agent && similarity(m.text, text) >= MERGE_SIMILARITY);
    if (dup) {
      dup.importance = Math.min(1, dup.importance + 0.1);
      dup.lastUsed = now;
      dup.pinned = dup.pinned || pinned;
      this.store.save();
      return dup.id;
    }
    const item: MemoryItem = {
      id: this.store.data.nextId++,
      agent,
      text: text.slice(0, 500),
      importance: Math.max(0, Math.min(1, importance)),
      pinned,
      hits: 0,
      createdAt: now,
      lastUsed: now,
    };
    this.store.data.items.push(item);
    this.store.save();
    return item.id;
  }

  setPinned(id: number, pinned: boolean) {
    const m = this.store.data.items.find((x) => x.id === id);
    if (m) {
      m.pinned = pinned;
      this.store.save();
    }
    return Boolean(m);
  }

  remove(id: number) {
    const before = this.store.data.items.length;
    this.store.data.items = this.store.data.items.filter((x) => x.id !== id);
    this.store.save();
    return this.store.data.items.length < before;
  }

  /** Memories relevant to a prompt, for one agent (its own plus shared ones). */
  recall(query: string, agent: string, limit = 6): string[] {
    const q = words(query);
    const now = Date.now();
    const scored = this.store.data.items
      .filter((m) => m.agent === "shared" || m.agent === agent)
      .map((m) => {
        let overlap = 0;
        for (const w of words(m.text)) if (q.has(w)) overlap++;
        return { m, overlap, score: overlap + m.importance + (m.pinned ? 2 : 0) };
      })
      .filter((s) => s.overlap > 0 || s.m.pinned)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    for (const { m } of scored) {
      m.hits++;
      m.lastUsed = now;
    }
    if (scored.length) this.store.save();
    return scored.map((s) => s.m.text);
  }

  /** Ask the model which durable facts from one exchange are worth keeping. */
  async extract(agent: string, prompt: string, answer: string): Promise<string[]> {
    const data = await this.chat(this.model, [
      {
        role: "system",
        content:
          "Extract durable facts worth remembering about the user, their projects, preferences, decisions or setup. " +
          "Skip small talk and one-off details. Reply with JSON only: " +
          '{"memories": [{"text": "...", "importance": 0.0-1.0, "shared": true}]} and an empty list if nothing is worth keeping.',
      },
      { role: "user", content: `USER: ${prompt.slice(0, 3000)}\n\nASSISTANT: ${answer.slice(0, 3000)}` },
    ]);
    const saved: string[] = [];
    const items = Array.isArray(data.memories) ? data.memories.slice(0, 5) : [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as { text?: unknown; importance?: unknown; shared?: unknown };
      if (typeof item.text !== "string" || !item.text.trim()) continue;
      const importance = Number(item.importance);
      const owner = item.shared === false ? agent : "shared";
      if (this.add(item.text, owner, Number.isFinite(importance) ? importance : 0.5) !== null) saved.push(item.text);
    }
    return saved;
  }

  maintain(now = Date.now()) {
    let decayed = 0;
    let forgotten = 0;
    let merged = 0;
    const keep: MemoryItem[] = [];
    for (const m of this.store.data.items) {
      if (m.pinned) {
        keep.push(m);
        continue;
      }
      const idleDays = Math.max(0, (now - m.lastUsed) / DAY);
      const next = m.importance * DECAY_PER_DAY ** idleDays;
      if (next < FORGET_BELOW) {
        forgotten++;
        continue;
      }
      if (Math.abs(next - m.importance) > 1e-4) {
        m.importance = next;
        m.lastUsed = now; // don't charge the same idle time twice
        decayed++;
      }
      keep.push(m);
    }
    keep.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance);
    const gone = new Set<number>();
    for (let i = 0; i < keep.length; i++) {
      const a = keep[i];
      if (gone.has(a.id)) continue;
      for (const b of keep.slice(i + 1)) {
        if (gone.has(b.id) || b.pinned || a.agent !== b.agent) continue;
        if (similarity(a.text, b.text) >= MERGE_SIMILARITY) {
          a.importance = Math.min(1, Math.max(a.importance, b.importance) + 0.05);
          a.hits += b.hits;
          gone.add(b.id);
          merged++;
        }
      }
    }
    this.store.data.items = keep.filter((m) => !gone.has(m.id));
    this.store.save();
    return { decayed, forgotten, merged };
  }
}
