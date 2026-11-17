// Applies brain/db/migrations/*.sql in filename order, each in its own
// transaction, and records it in schema_migrations. Runs automatically when
// Mission Control starts; safe to re-run; concurrent runs wait on a lock.
//
//   npm run brain:migrate              apply pending migrations
//   npm run brain:migrate -- --status  list applied / pending, change nothing
//
// Migrations must not use statements that refuse to run inside a transaction
// (e.g. CREATE INDEX CONCURRENTLY).

import { readdirSync, readFileSync } from "fs";
import path from "path";
import type { Pool } from "pg";

export const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "brain", "db", "migrations");
const LOCK_KEY = 7_231_001; // fixed advisory-lock id for this app

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
}

/** Applies pending migrations (or, with statusOnly, just reports). Returns what ran. */
export async function runMigrations(pool: Pool, opts: { statusOnly?: boolean; log?: (s: string) => void } = {}): Promise<MigrationStatus> {
  const log = opts.log ?? (() => {});
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const baseline = await client.query(`SELECT to_regclass('public.memories') IS NOT NULL AS ok`);
    if (!baseline.rows[0].ok) {
      throw new Error("Brain baseline schema not found: the brain-db container loads brain/db/schema.sql on its first start.");
    }
    await client.query(`INSERT INTO schema_migrations (id) VALUES ('0000_baseline') ON CONFLICT DO NOTHING`);

    const done = new Set((await client.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id));
    const files = migrationFiles();
    const pending = files.filter((f) => !done.has(f.replace(/\.sql$/, "")));
    const status = { applied: files.filter((f) => !pending.includes(f)), pending };
    if (opts.statusOnly || pending.length === 0) return status;

    for (const file of pending) {
      const id = file.replace(/\.sql$/, "");
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
        await client.query("COMMIT");
        log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return { applied: files, pending: [] };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getPool } = require("./db") as typeof import("./db");
  const statusOnly = process.argv.includes("--status");
  runMigrations(getPool(), { statusOnly, log: console.log })
    .then((s) => {
      if (statusOnly) for (const f of [...s.applied.map((a) => `applied  ${a}`), ...s.pending.map((p) => `pending  ${p}`)]) console.log(f);
      else console.log(s.pending.length ? "" : "Brain database is up to date.");
      return getPool().end();
    })
    .catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
}
