import type { JsonChat } from "./ollama";
import { privateBlock, sanitize } from "./privacy";
import { JsonStore } from "./store";

// Long-term memory. After each task a small model pulls out durable facts.
// Every maintenance pass (default every 30 minutes) unpinned memories decay
// with disuse, faded ones are forgotten and near-duplicates are merged.
// Pinned memories never decay or get removed.

export interface MemoryItem {
  id: string;
  agent: string; // "shared" or an agent key
  text: string;
  importance: number;
  pinned: boolean;
  hits: number;
  createdAt: number;
  lastUsed: number;
  /** Cloud models never see a private memory. Memories are private unless marked otherwise. */
  private: boolean;
}

export type NewMemory = Omit<MemoryItem, "id" | "hits">;
export type MemoryPatch = Partial<Pick<MemoryItem, "importance" | "pinned" | "hits" | "lastUsed" | "private">>;

/**
 * Where memories live. The JSON file (data/memories.json) is the original
 * store; the brain store keeps them in the shared Postgres database so
 * outside clients (Claude Code over MCP) can use the same memory.
 */
export interface MemoryStore {
  readonly kind: string;
  /** HQ's own memories (facts), any order */
  list(): Promise<MemoryItem[]>;
  /** One owner's memories, for spotting duplicates */
  owned(agent: string): Promise<MemoryItem[]>;
  insert(item: NewMemory): Promise<string>;
  update(id: string, patch: MemoryPatch): Promise<boolean>;
  remove(ids: string[]): Promise<number>;
  /** Up to `limit` relevant memory texts for an agent (its own, shared and pinned ones); bumps their use counters */
  recall(query: string, agent: string, limit: number): Promise<string[]>;
  count(): Promise<number>;
}

interface MemoryData {
  nextId: number;
  items: (Omit<MemoryItem, "id" | "private"> & { id: number; private?: boolean })[];
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

/** The original store: a JSON file, with word-overlap recall. */
export class JsonMemoryStore implements MemoryStore {
  readonly kind = "json";
  private store: JsonStore<MemoryData>;

  constructor(dataDir: string) {
    this.store = new JsonStore<MemoryData>(dataDir, "memories.json", { nextId: 1, items: [] });
  }

  private view(m: MemoryData["items"][number]): MemoryItem {
    return { ...m, id: String(m.id), private: m.private ?? true };
  }

  async list() {
    return this.store.data.items.map((m) => this.view(m));
  }

  async owned(agent: string) {
    return this.store.data.items.filter((m) => m.agent === agent).map((m) => this.view(m));
  }

  async insert(item: NewMemory) {
    const id = this.store.data.nextId++;
    this.store.data.items.push({ ...item, id, hits: 0 });
    this.store.save();
    return String(id);
  }

  async update(id: string, patch: MemoryPatch) {
    const m = this.store.data.items.find((x) => String(x.id) === id);
    if (!m) return false;
    Object.assign(m, patch);
    this.store.save();
    return true;
  }

  async remove(ids: string[]) {
    const drop = new Set(ids);
    const before = this.store.data.items.length;
    this.store.data.items = this.store.data.items.filter((x) => !drop.has(String(x.id)));
    this.store.save();
    return before - this.store.data.items.length;
  }

  async recall(query: string, agent: string, limit: number) {
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

  async count() {
    return this.store.data.items.length;
  }

  /** Raw items, for the one-time import into the brain */
  legacyItems() {
    return this.store.data.items.map((m) => ({ ...m, private: m.private ?? true }));
  }
}

export interface MaintenancePlan {
  updates: { id: string; patch: MemoryPatch }[];
  remove: string[];
  stats: { decayed: number; forgotten: number; merged: number };
}

/**
 * Decay, forgetting and merging, as a plan any store can apply. Unpinned
 * memories fade with disuse; faded ones are forgotten; near-duplicates with the
 * same owner merge into the more important one. Pinned memories are kept as they are.
 */
export function planMaintenance(items: MemoryItem[], now = Date.now()): MaintenancePlan {
  const stats = { decayed: 0, forgotten: 0, merged: 0 };
  const updates = new Map<string, MemoryPatch>();
  const remove: string[] = [];
  const keep: MemoryItem[] = [];
  for (const m of items) {
    if (m.pinned) {
      keep.push({ ...m });
      continue;
    }
    const idleDays = Math.max(0, (now - m.lastUsed) / DAY);
    const next = m.importance * DECAY_PER_DAY ** idleDays;
    if (next < FORGET_BELOW) {
      stats.forgotten++;
      remove.push(m.id);
      continue;
    }
    const copy = { ...m };
    if (Math.abs(next - m.importance) > 1e-4) {
      copy.importance = next;
      copy.lastUsed = now; // don't charge the same idle time twice
      updates.set(m.id, { importance: next, lastUsed: now });
      stats.decayed++;
    }
    keep.push(copy);
  }
  keep.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance);
  const gone = new Set<string>();
  for (let i = 0; i < keep.length; i++) {
    const a = keep[i];
    if (gone.has(a.id)) continue;
    for (const b of keep.slice(i + 1)) {
      if (gone.has(b.id) || b.pinned || a.agent !== b.agent) continue;
      if (similarity(a.text, b.text) >= MERGE_SIMILARITY) {
        a.importance = Math.min(1, Math.max(a.importance, b.importance) + 0.05);
        a.hits += b.hits;
        // The merged memory stays private if either half was
        a.private = a.private || b.private;
        updates.set(a.id, { ...(updates.get(a.id) ?? {}), importance: a.importance, hits: a.hits, private: a.private });
        gone.add(b.id);
        stats.merged++;
      }
    }
  }
  for (const id of gone) {
    remove.push(id);
    updates.delete(id);
  }
  return { updates: [...updates].map(([id, patch]) => ({ id, patch })), remove, stats };
}

export class Memory {
  private store: MemoryStore;
  private chat: JsonChat;
  private model: string;

  /** `store` may be a data folder, for the JSON store. */
  constructor(store: MemoryStore | string, chat: JsonChat, model: string) {
    this.store = typeof store === "string" ? new JsonMemoryStore(store) : store;
    this.chat = chat;
    this.model = model;
  }

  /** Switch storage (e.g. to the brain once it has started). */
  useStore(store: MemoryStore) {
    this.store = store;
  }

  get storeKind() {
    return this.store.kind;
  }

  async list(): Promise<MemoryItem[]> {
    return (await this.store.list()).sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.createdAt - a.createdAt,
    );
  }

  count() {
    return this.store.count();
  }

  async add(text: string, agent = "shared", importance = 0.5, pinned = false, isPrivate = true): Promise<string | null> {
    text = text.trim();
    if (text.length < 8) return null;
    const now = Date.now();
    const dup = (await this.store.owned(agent)).find((m) => similarity(m.text, text) >= MERGE_SIMILARITY);
    if (dup) {
      await this.store.update(dup.id, {
        importance: Math.min(1, dup.importance + 0.1),
        lastUsed: now,
        pinned: dup.pinned || pinned,
        private: dup.private || isPrivate,
      });
      return dup.id;
    }
    return this.store.insert({
      agent,
      text: text.slice(0, 500),
      importance: Math.max(0, Math.min(1, importance)),
      pinned,
      createdAt: now,
      lastUsed: now,
      private: isPrivate,
    });
  }

  setPinned(id: string, pinned: boolean) {
    return this.store.update(id, { pinned });
  }

  setPrivate(id: string, isPrivate: boolean) {
    return this.store.update(id, { private: isPrivate });
  }

  async remove(id: string) {
    return (await this.store.remove([id])) > 0;
  }

  /** Memories relevant to a prompt, for one agent (its own plus shared ones). */
  recall(query: string, agent: string, limit = 6): Promise<string[]> {
    return this.store.recall(query, agent, limit);
  }

  /** Ask the model which durable facts from one exchange are worth keeping. */
  /** `privateAnswer`: the answer was written from private material, so a cloud model must not see it, and its facts stay private. */
  async extract(agent: string, prompt: string, answer: string, privateAnswer = false): Promise<string[]> {
    const shown = sanitize(answer.slice(0, 3000));
    const data = await this.chat(this.model, [
      {
        role: "system",
        content:
          "Extract durable facts worth remembering about the user, their projects, preferences, decisions or setup. " +
          "Skip small talk and one-off details. Reply with JSON only: " +
          '{"memories": [{"text": "...", "importance": 0.0-1.0, "shared": true}]} and an empty list if nothing is worth keeping.',
      },
      { role: "user", content: `USER: ${sanitize(prompt.slice(0, 3000))}\n\nASSISTANT: ${privateAnswer ? privateBlock(shown, "(withheld)") : shown}` },
    ]);
    const saved: string[] = [];
    const items = Array.isArray(data.memories) ? data.memories.slice(0, 5) : [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as { text?: unknown; importance?: unknown; shared?: unknown };
      if (typeof item.text !== "string" || !item.text.trim()) continue;
      const importance = Number(item.importance);
      const owner = item.shared === false ? agent : "shared";
      if ((await this.add(item.text, owner, Number.isFinite(importance) ? importance : 0.5, false, privateAnswer)) !== null) saved.push(item.text);
    }
    return saved;
  }

  async maintain(now = Date.now()) {
    const plan = planMaintenance(await this.store.list(), now);
    for (const u of plan.updates) await this.store.update(u.id, u.patch);
    if (plan.remove.length) await this.store.remove(plan.remove);
    return plan.stats;
  }
}
