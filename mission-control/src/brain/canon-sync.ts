// Copies the Obsidian vault's HQ/ notes into the brain as canon docs, so
// every client (HQ's agents, Claude Code over MCP) has the same core
// documents. The vault stays the source: edits update the canon doc, deleted
// notes remove it. HQ/inbox and HQ/routines (agent output) are skipped.
//
// Vault notes are private. A note is shown to cloud clients only if its
// frontmatter says so:
//   ---
//   cloud: true
//   title: Company profile          (optional; else the first # heading or the file name)
//   summary: Who we are, what we sell (optional; else the first paragraph)
//   ---

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import type { Db } from "./db";

const SKIP_DIRS = new Set(["inbox", "routines"]);
const MAX_FILES = 500;
const MAX_BYTES = 200_000;

export interface CanonNote {
  sourcePath: string; // e.g. "HQ/shared.md"
  slug: string;
  title: string;
  summary: string;
  content: string;
  private: boolean;
  hash: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  skipped: string[];
}

function walk(dir: string, root: string, out: string[]) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (path.relative(root, full).split(path.sep).length === 1 && SKIP_DIRS.has(name.toLowerCase())) continue;
      walk(full, root, out);
    } else if (name.toLowerCase().endsWith(".md")) out.push(full);
  }
}

/** Splits simple YAML frontmatter (key: value lines) from the body. */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.slice(m[0].length) };
}

export function toCanonNote(sourcePath: string, raw: string): CanonNote {
  const { meta, body } = parseFrontmatter(raw);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = meta.title || heading || path.basename(sourcePath, ".md");
  const firstPara =
    body
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("#")) ?? "";
  const summary = (meta.summary || firstPara.replace(/\s+/g, " ")).slice(0, 200) || title;
  const slug = `vault-${sourcePath.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 120);
  return {
    sourcePath,
    slug,
    title: title.slice(0, 200),
    summary,
    content: body.trim(),
    private: !/^(true|yes|1)$/i.test(meta.cloud ?? ""),
    hash: createHash("sha256").update(raw).digest("hex"),
  };
}

/** Reads every note under <vault>/HQ (except inbox/ and routines/). */
export function readVaultCanon(vault: string): { notes: CanonNote[]; skipped: string[] } {
  const root = path.join(vault, "HQ");
  if (!vault || !existsSync(root)) return { notes: [], skipped: [] };
  const files: string[] = [];
  walk(root, root, files);
  const notes: CanonNote[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const rel = path.relative(vault, file).split(path.sep).join("/");
    if (notes.length >= MAX_FILES) {
      skipped.push(`${rel} (more than ${MAX_FILES} notes)`);
      continue;
    }
    if (statSync(file).size > MAX_BYTES) {
      skipped.push(`${rel} (larger than ${MAX_BYTES / 1000} KB)`);
      continue;
    }
    notes.push(toCanonNote(rel, readFileSync(file, "utf8")));
  }
  return { notes, skipped };
}

/** Brings the brain's vault canon docs in line with the vault. Workspace-wide (every department sees them). */
export async function syncVaultCanon(db: Db, workspaceId: string, vault: string): Promise<SyncResult> {
  const { notes, skipped } = readVaultCanon(vault);
  const result: SyncResult = { added: 0, updated: 0, removed: 0, unchanged: 0, skipped };
  for (const n of notes) {
    const { rows } = await db.query<{ inserted: boolean }>(
      `INSERT INTO canon_docs (workspace_id, department_id, slug, title, summary, content, private, source_path, source_hash, updated_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (workspace_id, slug) DO UPDATE
         SET title = EXCLUDED.title, summary = EXCLUDED.summary, content = EXCLUDED.content,
             private = EXCLUDED.private, source_path = EXCLUDED.source_path,
             source_hash = EXCLUDED.source_hash, updated_at = now()
         WHERE canon_docs.source_hash IS DISTINCT FROM EXCLUDED.source_hash
       RETURNING (xmax = 0) AS inserted`,
      [workspaceId, n.slug, n.title, n.summary, n.content, n.private, n.sourcePath, n.hash],
    );
    if (!rows.length) result.unchanged++;
    else if (rows[0].inserted) result.added++;
    else result.updated++;
  }
  // Notes that were deleted or moved out of HQ/ leave the canon too
  const gone = await db.query(
    `DELETE FROM canon_docs WHERE workspace_id = $1 AND source_path IS NOT NULL AND NOT (source_path = ANY($2::text[])) RETURNING id`,
    [workspaceId, notes.map((n) => n.sourcePath)],
  );
  result.removed = gone.rows.length;
  return result;
}
