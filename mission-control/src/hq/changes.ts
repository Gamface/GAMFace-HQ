// The change history ("time travel"): every file an agent writes is recorded with its
// content before and after, so any card's changes can be looked at as a diff and undone,
// even after later changes (a file changed since asks before it's overwritten). Undoing
// is itself a change, so it can be redone. Contents are kept by hash in DATA_DIR/blobs.

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { hunks } from "./diff";
import type { Hunk } from "./diff";

export type Root = { kind: "workspace"; name: string } | { kind: "vault" };

export interface FileAccess {
  read(rel: string): { text: string | null } | { error: string };
  write(rel: string, text: string | null): { rel: string } | { error: string };
}

export interface FileChange {
  path: string;
  before: string | null; // content hash; null: the file didn't exist
  after: string | null; // null: deleted
  added: number;
  removed: number;
}

export interface ChangeSet {
  id: string;
  at: number;
  taskId?: string;
  project: string | null;
  label: string;
  root: Root;
  files: FileChange[];
  by: "agent" | "user";
  // This set undoes (or redoes) another
  undoes?: string;
  // Undone by this set
  undoneBy?: string;
}

export interface FileDetail extends FileChange {
  hunks: Hunk[];
  tooBig: boolean;
}

const MAX_SETS = 5000;

export const rootLabel = (r: Root) => (r.kind === "vault" ? "your vault" : `workspace “${r.name}”`);

export class Changes {
  private blobs: string;

  constructor(
    private db: DatabaseSync,
    dataDir: string,
    private access: (root: Root) => FileAccess | null,
  ) {
    this.blobs = path.join(dataDir, "blobs");
    if (dataDir !== ":memory:") mkdirSync(this.blobs, { recursive: true });
    db.exec("CREATE TABLE IF NOT EXISTS changesets (id TEXT PRIMARY KEY, at INTEGER NOT NULL, task_id TEXT, project TEXT, data TEXT NOT NULL)");
    db.exec("CREATE INDEX IF NOT EXISTS changesets_at ON changesets(at)");
  }

  private memBlobs = new Map<string, string>();

  private put(text: string | null): string | null {
    if (text === null) return null;
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (this.blobs.startsWith(":memory:")) {
      this.memBlobs.set(hash, text);
      return hash;
    }
    const file = path.join(this.blobs, hash.slice(0, 2), hash);
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return hash;
  }

  /** A stored content, by hash. */
  blob(hash: string | null): string | null {
    if (hash === null) return null;
    if (this.memBlobs.has(hash)) return this.memBlobs.get(hash)!;
    const file = path.join(this.blobs, hash.slice(0, 2), hash);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  private save(set: ChangeSet) {
    this.db.prepare("INSERT OR REPLACE INTO changesets (id, at, task_id, project, data) VALUES (?, ?, ?, ?, ?)").run(set.id, set.at, set.taskId ?? null, set.project, JSON.stringify(set));
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM changesets").get() as { n: number }).n;
    if (n > MAX_SETS) this.db.prepare("DELETE FROM changesets WHERE id IN (SELECT id FROM changesets ORDER BY at LIMIT ?)").run(n - MAX_SETS);
  }

  get(id: string): ChangeSet | undefined {
    const row = this.db.prepare("SELECT data FROM changesets WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ChangeSet) : undefined;
  }

  /** Newest first. project: undefined for all, null for General. */
  list(opts: { project?: string | null; taskId?: string; limit?: number } = {}): ChangeSet[] {
    const where: string[] = [];
    const args: (string | number | null)[] = [];
    if (opts.taskId) {
      where.push("task_id = ?");
      args.push(opts.taskId);
    }
    if (opts.project !== undefined) {
      where.push(opts.project === null ? "project IS NULL" : "project = ?");
      if (opts.project !== null) args.push(opts.project);
    }
    args.push(Math.min(opts.limit ?? 100, 500));
    const rows = this.db.prepare(`SELECT data FROM changesets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, rowid DESC LIMIT ?`).all(...args) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as ChangeSet);
  }

  /**
   * Writes files (text null deletes) and records the change. Files that end up the
   * same as before are left out; a set with nothing in it isn't saved.
   */
  apply(meta: { taskId?: string; project: string | null; label: string; root: Root; by?: "agent" | "user"; undoes?: string }, ops: { path: string; text: string | null }[]): { set: ChangeSet | null; errors: string[] } {
    const fs = this.access(meta.root);
    if (!fs) return { set: null, errors: [`${rootLabel(meta.root)} isn't available`] };
    const errors: string[] = [];
    const files: FileChange[] = [];
    for (const op of ops) {
      const cur = fs.read(op.path);
      if ("error" in cur) {
        errors.push(cur.error);
        continue;
      }
      if (cur.text === op.text) continue;
      const before = this.put(cur.text);
      const w = fs.write(op.path, op.text);
      if ("error" in w) {
        errors.push(w.error);
        continue;
      }
      const d = hunks(cur.text ?? "", op.text ?? "");
      files.push({ path: w.rel, before, after: this.put(op.text), added: d.added, removed: d.removed });
    }
    if (!files.length) return { set: null, errors };
    const set: ChangeSet = { id: crypto.randomUUID(), at: Date.now(), taskId: meta.taskId, project: meta.project, label: meta.label.slice(0, 200), root: meta.root, files, by: meta.by ?? "agent", undoes: meta.undoes };
    this.save(set);
    return { set, errors };
  }

  /** Records files that were already created (vault notes), so they can be undone too. */
  recordCreated(meta: { taskId?: string; project: string | null; label: string; root: Root }, created: { path: string; text: string }[]): ChangeSet | null {
    if (!created.length) return null;
    const files = created.map((c) => ({ path: c.path, before: null, after: this.put(c.text), added: hunks("", c.text).added, removed: 0 }));
    const set: ChangeSet = { id: crypto.randomUUID(), at: Date.now(), ...meta, files, by: "agent" };
    this.save(set);
    return set;
  }

  /** The set with each file's diff. */
  detail(id: string): (ChangeSet & { files: FileDetail[] }) | undefined {
    const set = this.get(id);
    if (!set) return undefined;
    return {
      ...set,
      files: set.files.map((f) => {
        const h = hunks(this.blob(f.before) ?? "", this.blob(f.after) ?? "");
        return { ...f, hunks: h.hunks, tooBig: h.tooBig };
      }),
    };
  }

  /** Files changed since this set (so undoing it would overwrite later work). */
  conflicts(set: ChangeSet): string[] {
    const fs = this.access(set.root);
    if (!fs) return set.files.map((f) => f.path);
    const out: string[] = [];
    for (const f of set.files) {
      const cur = fs.read(f.path);
      const now = "error" in cur ? undefined : cur.text;
      const expected = this.blob(f.after);
      if (now === undefined || now !== expected) out.push(f.path);
    }
    return out;
  }

  /**
   * Puts the files back as they were before the set. Files changed since need force.
   * The undo is recorded as a set of its own (undo it to redo).
   */
  undo(id: string, force = false): { set: ChangeSet } | { conflicts: string[] } | { error: string } {
    const set = this.get(id);
    if (!set) return { error: "Change not found" };
    if (set.undoneBy) return { error: "Already undone" };
    const conflicts = this.conflicts(set);
    if (conflicts.length && !force) return { conflicts };
    for (const f of set.files) if (f.before !== null && this.blob(f.before) === null) return { error: `The earlier version of ${f.path} is no longer stored` };
    const original = set.undoes ? this.get(set.undoes) : undefined;
    // Undoing an undo is a redo
    const label = original && set.label.startsWith("Undo: ") ? `Redo: ${original.label}` : `Undo: ${set.label}`;
    const out = this.apply(
      { taskId: set.taskId, project: set.project, label, root: set.root, by: "user", undoes: set.id },
      set.files.map((f) => ({ path: f.path, text: this.blob(f.before) })),
    );
    if (out.errors.length && !out.set) return { error: out.errors.join("; ") };
    const done = out.set ?? { id: crypto.randomUUID(), at: Date.now(), taskId: set.taskId, project: set.project, label, root: set.root, files: [], by: "user" as const, undoes: set.id };
    if (!out.set) this.save(done);
    set.undoneBy = done.id;
    this.save(set);
    // After a redo, the original counts as applied again
    if (original && original.undoneBy === set.id) {
      delete original.undoneBy;
      this.save(original);
    }
    return { set: done };
  }

  /** A project's sets move to General when the project is deleted. */
  moveProject(from: string, to: string | null) {
    for (const s of this.list({ project: from, limit: 500 })) this.save({ ...s, project: to });
  }
}
