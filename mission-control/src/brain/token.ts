// Creates or revokes MCP client tokens for the brain. Run inside the harness
// container (it has DATABASE_URL):
//
//   docker compose exec harness npm run brain:token -- claude-code
//   docker compose exec harness npm run brain:token -- my-local-agent --agent planner --allow-private
//   docker compose exec harness npm run brain:token -- claude-code --revoke
//
// Options:
//   --agent <slug>    persona the token starts as (default: claude-code)
//   --agents a,b|*    other personas it may switch to (default: none)
//   --allow-private   may read private memories and vault notes. Only for clients
//                     whose model runs on your own hardware; never for Claude Code.
//   --revoke          revoke every token with this client label
//
// Only a SHA-256 hash of the token is stored; it's printed once.

import { createHash, randomBytes } from "crypto";
import { getPool } from "./db";
import { CLAUDE_CODE_AGENT, WORKSPACE_SLUG, ensureHqBrain } from "./setup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const label = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !["--agent", "--agents"].includes(all[i - 1] ?? ""));
  if (!label || !/^[\w.-]{1,60}$/.test(label)) {
    throw new Error("Usage: npm run brain:token -- <client-label> [--agent slug] [--agents a,b|*] [--allow-private] [--revoke]");
  }
  const pool = getPool();
  try {
    if (process.argv.includes("--revoke")) {
      const { rowCount } = await pool.query(`UPDATE api_tokens SET revoked_at = now() WHERE client_label = $1 AND revoked_at IS NULL`, [label]);
      console.log(`Revoked ${rowCount ?? 0} token(s) for ${label}. Open sessions end within MCP_SESSION_TTL_MINUTES.`);
      return;
    }
    await ensureHqBrain(pool);
    const agentSlug = arg("--agent") ?? CLAUDE_CODE_AGENT;
    const switchable = (arg("--agents") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const allowPrivate = process.argv.includes("--allow-private");

    const agent = await pool.query<{ id: string; workspace_id: string }>(
      `SELECT a.id, a.workspace_id FROM agents a JOIN workspaces w ON w.id = a.workspace_id WHERE w.slug = $1 AND a.slug = $2`,
      [WORKSPACE_SLUG, agentSlug],
    );
    if (!agent.rows[0]) throw new Error(`No agent '${agentSlug}' in the brain.`);

    const token = randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO api_tokens (token_hash, workspace_id, default_agent_id, client_label, allowed_agent_slugs, allow_private)
       VALUES ($1, $2, $3, $4, $5::text[], $6)`,
      [createHash("sha256").update(token).digest("hex"), agent.rows[0].workspace_id, agent.rows[0].id, label, switchable, allowPrivate],
    );

    const url = process.env.BRAIN_PUBLIC_URL || "http://localhost:3010/mcp";
    console.log(`Token for ${label} (agent ${agentSlug}${allowPrivate ? ", CAN read private memories" : ", shared memories only"}):\n`);
    console.log(`  ${token}\n`);
    console.log("It is shown only once. Connect Claude Code (run on your PC, not in the container):\n");
    console.log(`  claude mcp add --transport http --scope user gamface-brain ${url} --header "Authorization: Bearer ${token}"\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
