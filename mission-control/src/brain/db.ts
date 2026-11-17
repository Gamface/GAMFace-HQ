// The brain's Postgres connection. Everything that only needs to run queries
// takes the small `Db` interface, so it can be tested without a pool.
import type { Pool } from "pg";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

let pool: Pool | undefined;

/** The shared pool (created on first use from DATABASE_URL; no connection until a query). */
export function getPool(): Pool {
  if (!pool) {
    // Loaded lazily so code that only needs the Db type doesn't require the pg package
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pg = require("pg") as typeof import("pg");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    pool.on("error", (err) => console.error("[brain] idle database client error:", err.message));
  }
  return pool;
}

export const brainEnabled = () => Boolean(process.env.DATABASE_URL);

/** Waits for the database to accept connections (it may still be starting). */
export async function waitForDb(db: Db, attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await db.query("SELECT 1");
      return;
    } catch (err) {
      if (i >= attempts) throw new Error(`Brain database unreachable: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
