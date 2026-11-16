// Skills and searchable history (Phase 6, ideas from Hermes Agent).
//
// Skills: after a complex task, a local model drafts a reusable procedure from it.
// Drafts do nothing until you approve them on the Skills page. Active skills whose
// words match a new request are added to the agent's instructions for that request.
// A skill drafted from private material (vault notes, memories, attachments) stays
// private: it is withheld from cloud models like the material it came from.
//
// History: every card's request, conversation and answer go into a full-text index
// (SQLite FTS5) so you can search past work from the board.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const SkillInputSchema = z.object({
  name: z.string().trim().min(3).max(60),
  description: z.string().trim().min(5).max(300),
  // Which agents may use it; empty means any
  agents: z.array(z.enum(["planner", "coder", "browser", "file", "security_audit", "vision"])).max(6).default([]),
  steps: z.string().trim().min(10).max(4000),
});
export const SkillPatchSchema = SkillInputSchema.partial().extend({ status: z.enum(["draft", "active", "off"]).optional() });
export type SkillInput = z.infer<typeof SkillInputSchema>;

export interface Skill extends SkillInput {
  id: string;
  status: "draft" | "active" | "off";
  private: boolean;
  sourceTaskId?: string;
  sourceTitle?: string;
  // A draft that would update an existing skill with the same name
  replaces?: string;
  createdAt: number;
  updatedAt: number;
  uses: number;
  lastUsedAt?: number;
}

export const MAX_SKILLS = 200;

const STOP = new Set(
  "a an and are as at be but by can could do does for from get give has have how i if in into is it its me my of on or our please should so than that the their them then there these this to us use using was we what when where which who why will with would you your about make need want just also like".split(" "),
);

/** The words of a request worth matching on (lowercase, 3+ letters, no common words). */
export function keywords(text: string, max = 16): string[] {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? []) {
    const word = w.replace(/'s$/, "").replace(/['-]/g, "");
    if (word.length >= 3 && !STOP.has(word) && !/^\d+$/.test(word)) seen.add(word);
    if (seen.size >= max) break;
  }
  return [...seen];
}

const ftsQuery = (words: string[]) => words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" OR ");
// A rough stem, so "searching" and "search" count as the same word when scoring a match
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "").slice(0, 7);

export class Skills {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(id UNINDEXED, name, description, steps, tokenize = "porter unicode61");
    `);
  }

  private write(s: Skill) {
    this.db.prepare("INSERT INTO skills (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(s.id, JSON.stringify(s));
    this.db.prepare("DELETE FROM skills_fts WHERE id = ?").run(s.id);
    this.db.prepare("INSERT INTO skills_fts (id, name, description, steps) VALUES (?, ?, ?, ?)").run(s.id, s.name, s.description, s.steps);
  }

  list(): Skill[] {
    return (this.db.prepare("SELECT data FROM skills").all() as { data: string }[])
      .map((r) => JSON.parse(r.data) as Skill)
      .sort((a, b) => (a.status === b.status ? b.updatedAt - a.updatedAt : a.status === "draft" ? -1 : b.status === "draft" ? 1 : a.status === "active" ? -1 : 1));
  }

  get(id: string): Skill | undefined {
    const row = this.db.prepare("SELECT data FROM skills WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Skill) : undefined;
  }

  byName(name: string): Skill | undefined {
    const n = name.trim().toLowerCase();
    return this.list().find((s) => s.name.toLowerCase() === n && s.status !== "draft");
  }

  /** Adds a skill. Drafts named like an existing skill are marked as an update to it. */
  create(raw: unknown, opts: { status?: Skill["status"]; private?: boolean; sourceTaskId?: string; sourceTitle?: string } = {}): Skill | { error: string } {
    const parsed = SkillInputSchema.safeParse(raw);
    if (!parsed.success) {
      const f = parsed.error.flatten().fieldErrors;
      const [k, v] = Object.entries(f)[0] ?? ["skill", ["is invalid"]];
      return { error: `${k}: ${v?.[0]}` };
    }
    if (this.list().length >= MAX_SKILLS) return { error: `At most ${MAX_SKILLS} skills` };
    const status = opts.status ?? "draft";
    const existing = this.byName(parsed.data.name);
    if (existing && status !== "draft") return { error: `There's already a skill called “${existing.name}”` };
    const now = Date.now();
    const s: Skill = {
      ...parsed.data,
      id: crypto.randomUUID(),
      status,
      private: Boolean(opts.private),
      sourceTaskId: opts.sourceTaskId,
      sourceTitle: opts.sourceTitle?.slice(0, 120),
      replaces: existing?.id,
      createdAt: now,
      updatedAt: now,
      uses: 0,
    };
    this.write(s);
    return s;
  }

  update(id: string, raw: unknown): Skill | { error: string } {
    const s = this.get(id);
    if (!s) return { error: "Skill not found" };
    const parsed = SkillPatchSchema.safeParse(raw);
    if (!parsed.success) return { error: "Invalid skill" };
    const { status, ...fields } = parsed.data;
    const next: Skill = { ...s, ...fields, updatedAt: Date.now() };
    if (status === "active" && s.status === "draft") return this.approve(id, next);
    if (status) next.status = status;
    this.write(next);
    return next;
  }

  /** Approving a draft switches it on; a draft that updates a skill replaces that skill's content. */
  approve(id: string, edited?: Skill): Skill | { error: string } {
    const draft = edited ?? this.get(id);
    if (!draft) return { error: "Skill not found" };
    const target = draft.replaces ? this.get(draft.replaces) : undefined;
    if (target) {
      const merged: Skill = {
        ...target,
        description: draft.description,
        agents: draft.agents,
        steps: draft.steps,
        private: target.private || draft.private,
        status: "active",
        updatedAt: Date.now(),
        sourceTaskId: draft.sourceTaskId,
        sourceTitle: draft.sourceTitle,
      };
      this.write(merged);
      this.remove(draft.id);
      return merged;
    }
    const clash = this.byName(draft.name);
    if (clash && clash.id !== draft.id) return { error: `There's already a skill called “${clash.name}”` };
    const active: Skill = { ...draft, status: "active", replaces: undefined, updatedAt: Date.now() };
    this.write(active);
    return active;
  }

  remove(id: string): boolean {
    const r = this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM skills_fts WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  }

  /** Whether a task already produced a draft (so it isn't drafted twice). */
  draftedFrom(taskId: string): boolean {
    return this.list().some((s) => s.sourceTaskId === taskId);
  }

  /** Active skills for this agent whose words match the request: at most `limit`, best first. */
  match(request: string, agent: string, limit = 2): Skill[] {
    const words = keywords(request);
    if (words.length < 2) return [];
    let rows: { id: string }[];
    try {
      rows = this.db.prepare("SELECT id FROM skills_fts WHERE skills_fts MATCH ? ORDER BY bm25(skills_fts, 0, 5.0, 3.0, 1.0) LIMIT 20").all(ftsQuery(words)) as { id: string }[];
    } catch {
      return [];
    }
    const wanted = new Set(words.map(stem));
    const out: Skill[] = [];
    for (const { id } of rows) {
      const s = this.get(id);
      if (!s || s.status !== "active" || (s.agents.length && !s.agents.includes(agent as never))) continue;
      // Needs two of the request's words in the skill's name or description, so a skill
      // isn't pulled in by one shared word
      const own = new Set(keywords(`${s.name} ${s.description}`, 40).map(stem));
      if ([...wanted].filter((w) => own.has(w)).length < 2) continue;
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  recordUse(id: string) {
    const s = this.get(id);
    if (!s) return;
    this.write({ ...s, uses: s.uses + 1, lastUsedAt: Date.now() });
  }
}

/** What a model is asked when drafting a skill from a finished task. */
export const SKILL_DRAFT_SYSTEM =
  "You turn finished tasks into reusable skills: short, general procedures an agent can follow the next time a similar task comes up. " +
  "Reply with JSON only.";

export function skillDraftPrompt(t: { request: string; agents: string[]; answer: string; steps?: string }): string {
  return (
    `TASK: ${t.request.slice(0, 1500)}\nAGENTS THAT WORKED ON IT: ${t.agents.join(", ")}\n` +
    (t.steps ? `WHAT THEY DID:\n${t.steps.slice(0, 2500)}\n` : "") +
    `RESULT:\n${t.answer.slice(0, 3500)}\n\n` +
    'If this shows a procedure worth reusing for similar tasks, reply {"skill": {"name": "<3 to 6 words>", "description": "<one sentence: when to use it>", ' +
    '"agents": ["<which of planner, coder, browser, file, security_audit, vision should use it>"], "steps": "<numbered steps, general: no one-off names, dates, numbers, links or personal details>"}}. ' +
    'If it was a one-off question or a simple lookup, reply {"skill": null}.'
  );
}

// --- History search ------------------------------------------------------------

export interface HistoryHit {
  taskId: string;
  title: string;
  snippet: string;
  rank: number;
}

export class HistoryIndex {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(task_id UNINDEXED, title, body, tokenize = "porter unicode61");`);
  }

  put(task: { id: string; title?: string; prompt: string; reply?: string; answer?: string; error?: string; thread?: { text: string }[] }) {
    const body = [task.prompt, ...(task.thread ?? []).map((t) => t.text), task.reply, task.answer ?? task.error].filter(Boolean).join("\n\n").slice(0, 30000);
    this.db.prepare("DELETE FROM history_fts WHERE task_id = ?").run(task.id);
    this.db.prepare("INSERT INTO history_fts (task_id, title, body) VALUES (?, ?, ?)").run(task.id, task.title || task.prompt.slice(0, 80), body);
  }

  remove(taskId: string) {
    this.db.prepare("DELETE FROM history_fts WHERE task_id = ?").run(taskId);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM history_fts").get() as { n: number }).n;
  }

  /** Cards matching the words, best first, with the matching part highlighted «like this». */
  search(q: string, limit = 25): HistoryHit[] {
    // Quoted phrases stay phrases; other words match as prefixes
    const phrases = [...q.matchAll(/"([^"]{2,80})"/g)].map((m) => `"${m[1].replace(/"/g, "")}"`);
    const words = q
      .replace(/"[^"]*"/g, " ")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu)
      ?.slice(0, 10)
      .map((w) => `"${w}"*`) ?? [];
    const terms = [...phrases, ...words];
    if (!terms.length) return [];
    try {
      return (
        this.db
          .prepare(
            `SELECT task_id AS taskId, title, snippet(history_fts, 2, '«', '»', '…', 14) AS snippet, bm25(history_fts, 0, 4.0, 1.0) AS rank
             FROM history_fts WHERE history_fts MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(terms.join(" AND "), limit) as unknown as HistoryHit[]
      ).map((h) => ({ ...h, snippet: h.snippet.replace(/\s+/g, " ") }));
    } catch {
      return [];
    }
  }
}
