import { mkdirSync } from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import type { AgentStatus, AgentStreamPayload, AgentTarget, Priority, Routine, TaskSummary } from "../schemas/agent";
import { TERMINAL_STATUSES } from "../schemas/agent";

// Durable storage for tasks (board cards) and their event streams, using
// Node's built-in SQLite (no packages). Tasks stay in memory for speed and are
// written through to disk on every change, so a restart loses nothing.

export interface Task extends TaskSummary {
  events: AgentStreamPayload[];
  controller?: AbortController;
  abortReason?: "user" | "timeout";
  requestedAgent: string;
  activeAgent?: AgentTarget;
  chatId?: string;
  answer?: string;
  // When the task last entered the queue (for fair model grouping)
  queuedAt?: number;
  // A model chosen for this task only; otherwise the agent's own model is used
  modelOverride?: string;
  // Routine cards whose routine may act (with approvals); set by the server only
  mayAct?: boolean;
  // Transcripts and picture descriptions from this round, kept for the conversation history (private)
  privateNotes?: string;
}

// Fields kept only in memory
const VOLATILE = new Set(["events", "controller", "abortReason", "activeAgent"]);
export const RUNNING_STATUSES: readonly AgentStatus[] = ["routing", "thinking", "delegating", "streaming", "executing_tool", "writing_diff"];
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
// How many recent tasks keep their full event history in memory (for stream replay)
const HOT_TASKS = 50;

export class TaskStore {
  private db: DatabaseSync;
  readonly tasks = new Map<string, Task>();

  constructor(dataDir: string) {
    const file = dataDir === ":memory:" ? ":memory:" : path.join(dataDir, "mission-control.db");
    if (dataDir !== ":memory:") mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS tasks_created ON tasks(archived, created_at);
      CREATE TABLE IF NOT EXISTS events (
        event_id INTEGER PRIMARY KEY,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, event_id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, agent, model)
      );
    `);
    // Databases from before spend caps lack the cost column
    const cols = this.db.prepare("PRAGMA table_info(usage)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "cost_usd")) this.db.exec("ALTER TABLE usage ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0");
  }

  /** Loads recent cards. Runs cut short by a restart are marked interrupted and wait for Retry. */
  load(limit = 300): { recovered: number } {
    const rows = this.db
      .prepare("SELECT data FROM tasks WHERE archived = 0 ORDER BY created_at DESC LIMIT ?")
      .all(limit) as { data: string }[];
    let recovered = 0;
    rows.forEach((row, i) => {
      const task = JSON.parse(row.data) as Task;
      task.events = i < HOT_TASKS ? this.loadEvents(task.id) : [];
      if (RUNNING_STATUSES.includes(task.status)) {
        recovered++;
        if (task.parentId) {
          task.status = "canceled";
        } else {
          task.status = "error";
          task.interrupted = true;
          task.error = "Interrupted by a restart. Press Retry to run it again.";
        }
        task.finishedAt = Date.now();
        this.save(task);
      }
      this.tasks.set(task.id, task);
    });
    return { recovered };
  }

  private loadEvents(taskId: string): AgentStreamPayload[] {
    const rows = this.db.prepare("SELECT data FROM events WHERE task_id = ? ORDER BY event_id").all(taskId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as AgentStreamPayload);
  }

  /** Full event history, from memory or disk. */
  events(taskId: string): AgentStreamPayload[] {
    const task = this.tasks.get(taskId);
    if (task && task.events.length) return task.events;
    return this.loadEvents(taskId);
  }

  maxEventId(): number {
    const row = this.db.prepare("SELECT MAX(event_id) AS m FROM events").get() as { m: number | null };
    return row.m ?? 0;
  }

  /** The database itself, for indexes that live beside the tasks (skills, history search). */
  get sql(): DatabaseSync {
    return this.db;
  }

  save(task: Task) {
    const persisted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(task)) if (!VOLATILE.has(k) && v !== undefined) persisted[k] = v;
    this.db
      .prepare(
        `INSERT INTO tasks (id, data, status, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(task.id, JSON.stringify(persisted), task.status, task.parentId ?? null, task.createdAt, Date.now());
  }

  add(task: Task) {
    this.tasks.set(task.id, task);
    this.save(task);
  }

  appendEvent(payload: AgentStreamPayload) {
    this.db.prepare("INSERT INTO events (event_id, task_id, data) VALUES (?, ?, ?)").run(payload.eventId, payload.taskId, JSON.stringify(payload));
  }

  /** Hides a card from the board; its history stays on disk. */
  archive(taskId: string) {
    this.db.prepare("UPDATE tasks SET archived = 1 WHERE id = ? OR parent_id = ?").run(taskId, taskId);
    for (const t of [...this.tasks.values()]) if (t.id === taskId || t.parentId === taskId) this.tasks.delete(t.id);
  }

  /** A card on the board, or an archived one read from disk (marked archived). */
  find(taskId: string): (Task & { archived?: boolean }) | undefined {
    const live = this.tasks.get(taskId);
    if (live) return live;
    const row = this.db.prepare("SELECT data FROM tasks WHERE id = ? AND archived = 1").get(taskId) as { data: string } | undefined;
    if (!row) return undefined;
    const t = JSON.parse(row.data) as Task;
    return { ...t, events: [], archived: true };
  }

  /** Puts an archived card (and its subtasks) back on the board. */
  restore(taskId: string): Task | undefined {
    const rows = this.db.prepare("SELECT data FROM tasks WHERE (id = ? OR parent_id = ?) AND archived = 1").all(taskId, taskId) as { data: string }[];
    if (!rows.length) return undefined;
    this.db.prepare("UPDATE tasks SET archived = 0 WHERE id = ? OR parent_id = ?").run(taskId, taskId);
    for (const r of rows) {
      const t = JSON.parse(r.data) as Task;
      this.tasks.set(t.id, { ...t, events: [] });
    }
    return this.tasks.get(taskId);
  }

  archiveOne(taskId: string) {
    this.db.prepare("UPDATE tasks SET archived = 1 WHERE id = ?").run(taskId);
    this.tasks.delete(taskId);
  }

  /** Keeps memory bounded: older tasks drop their in-memory events (still on disk). */
  trim() {
    const sorted = [...this.tasks.values()].filter((t) => !t.parentId).sort((a, b) => b.createdAt - a.createdAt);
    sorted.slice(HOT_TASKS).forEach((t) => {
      if (TERMINAL_STATUSES.includes(t.status)) t.events = [];
    });
  }

  children(taskId: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.parentId === taskId).sort((a, b) => a.createdAt - b.createdAt);
  }

  queuedCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === "queued" && !t.parentId) n++;
    return n;
  }

  // --- settings (JSON values) ---------------------------------------------------
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown) {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  // --- token usage per agent per day --------------------------------------------
  recordUsage(agent: string, model: string, promptTokens: number, completionTokens: number, error = false, costUsd = 0) {
    const day = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(
        `INSERT INTO usage (day, agent, model, prompt_tokens, completion_tokens, requests, errors, cost_usd) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(day, agent, model) DO UPDATE SET prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens, requests = requests + 1, errors = errors + excluded.errors,
           cost_usd = cost_usd + excluded.cost_usd`,
      )
      .run(day, agent, model, promptTokens, completionTokens, error ? 1 : 0, costUsd);
  }

  usageToday(): { agent: string; model: string; prompt_tokens: number; completion_tokens: number; requests: number; errors: number; cost_usd: number }[] {
    const day = new Date().toISOString().slice(0, 10);
    return this.db.prepare("SELECT agent, model, prompt_tokens, completion_tokens, requests, errors, cost_usd FROM usage WHERE day = ?").all(day) as never;
  }

  /** Dollars spent this calendar month (UTC), for one agent or all of them. */
  spendThisMonth(agent?: string): number {
    const month = new Date().toISOString().slice(0, 7);
    const row = (
      agent
        ? this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE day LIKE ? AND agent = ?").get(`${month}%`, agent)
        : this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE day LIKE ?").get(`${month}%`)
    ) as { s: number };
    return row.s;
  }

  spendByAgentThisMonth(): Record<string, number> {
    const month = new Date().toISOString().slice(0, 7);
    const rows = this.db.prepare("SELECT agent, SUM(cost_usd) AS s FROM usage WHERE day LIKE ? GROUP BY agent").all(`${month}%`) as { agent: string; s: number }[];
    return Object.fromEntries(rows.map((r) => [r.agent, r.s]));
  }

  tokensToday(agent: string): number {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.db.prepare("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS n FROM usage WHERE day = ? AND agent = ?").get(day, agent) as { n: number };
    return row.n;
  }

  /** Every approval decision, for the record. */
  logApproval(a: { id: string; createdAt: number }) {
    this.db.prepare("INSERT INTO approvals (id, at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(a.id, a.createdAt, JSON.stringify(a));
  }

  approvalLog<T>(limit = 50): T[] {
    return (this.db.prepare("SELECT data FROM approvals ORDER BY at DESC LIMIT ?").all(limit) as { data: string }[]).map((r) => JSON.parse(r.data) as T);
  }

  routines(): Routine[] {
    return (this.db.prepare("SELECT data FROM routines").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Routine);
  }

  saveRoutine(r: Routine) {
    this.db.prepare("INSERT INTO routines (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(r.id, JSON.stringify(r));
  }

  deleteRoutine(id: string) {
    this.db.prepare("DELETE FROM routines WHERE id = ?").run(id);
  }

  close() {
    this.db.close();
  }
}

// --- Picking the next task ----------------------------------------------------------

export interface PickOptions {
  /** Model that ran last; a queued task on the same model can jump ahead to avoid a swap */
  lastModel?: string | null;
  /** Model a queued task will use, or null when unknown (auto-routed) */
  modelOf: (t: Task) => string | null;
  /** The front task is never kept waiting longer than this for model grouping */
  maxWaitMs?: number;
  now?: number;
}

/** A dependency is satisfied once it completed and, if it needs review, was accepted. */
function satisfied(dep: Task | undefined): boolean {
  return !dep || (dep.status === "complete" && (!dep.needsReview || Boolean(dep.acceptedAt)));
}

/** True when every card this one depends on is done (removed cards count as done). */
export function dependenciesMet(task: Task, all: Map<string, Task>): boolean {
  return (task.dependsOn ?? []).every((id) => satisfied(all.get(id)));
}

/** Card ids this one is still waiting on (failed or unreviewed dependencies included). */
export function waitingOn(task: Task, all: Map<string, Task>): string[] {
  return (task.dependsOn ?? []).filter((id) => all.has(id) && !satisfied(all.get(id)));
}

export function pickNext(all: Map<string, Task>, opts: PickOptions): Task | undefined {
  const now = opts.now ?? Date.now();
  const candidates = [...all.values()]
    .filter((t) => t.status === "queued" && !t.parentId && dependenciesMet(t, all))
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority ?? "normal"] - PRIORITY_RANK[b.priority ?? "normal"] ||
        (a.position ?? a.createdAt) - (b.position ?? b.createdAt) ||
        a.createdAt - b.createdAt,
    );
  const front = candidates[0];
  if (!front || !opts.lastModel) return front;
  if (opts.modelOf(front) === opts.lastModel) return front;
  const waited = now - (front.queuedAt ?? front.createdAt);
  if (waited >= (opts.maxWaitMs ?? 60_000)) return front;
  const sameModel = candidates.find((c) => (c.priority ?? "normal") === (front.priority ?? "normal") && opts.modelOf(c) === opts.lastModel);
  return sameModel ?? front;
}
