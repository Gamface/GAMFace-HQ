// Test helper: a `Db` that runs each query through the psql command line, for
// machines where the pg package isn't installed. Parameters are inlined as SQL
// literals and results come back as JSON, so every statement must return rows
// (SELECT, or INSERT/UPDATE/DELETE ... RETURNING). Not for production use.
import { spawnSync } from "child_process";
import type { Db } from "../../src/brain/db";

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (Array.isArray(v)) return literal(`{${v.map((x) => `"${String(x).replace(/["\\]/g, "\\$&")}"`).join(",")}}`);
  if (typeof v === "object") return literal(JSON.stringify(v));
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function psqlDb(args: string[]): Db {
  return {
    async query(sql: string, params: unknown[] = []) {
      let inlined = sql;
      for (let i = params.length; i >= 1; i--) inlined = inlined.split(`$${i}`).join(literal(params[i - 1]));
      const wrapped = `WITH __q AS (${inlined}) SELECT coalesce(json_agg(__q), '[]'::json) FROM __q`;
      const out = spawnSync("psql", [...args, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", wrapped], { encoding: "utf8" });
      if (out.status !== 0) throw new Error(out.stderr.trim() || `psql exited ${out.status}`);
      const rows = JSON.parse(out.stdout.trim() || "[]");
      return { rows, rowCount: rows.length };
    },
  };
}
