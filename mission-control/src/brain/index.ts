// Starts the brain inside Mission Control: migrations, HQ's agents, the
// memory store, the one-time import of memories.json, and the vault → canon
// sync. The MCP endpoint itself is mounted by ui.ts (createMcpRouter).

import { getPool, waitForDb } from "./db";
import { BrainMemoryStore, importLegacyMemories, type HqBrainIds } from "./memory-store";
import { runMigrations } from "./migrate";
import { ensureHqBrain } from "./setup";
import { syncVaultCanon, type SyncResult } from "./canon-sync";

export interface Brain {
  ids: HqBrainIds;
  memory: BrainMemoryStore;
  /** Re-reads the vault's HQ/ notes into canon docs */
  syncCanon(): Promise<SyncResult | null>;
  stop(): void;
}

export async function startBrain(opts: { dataDir: string; vault: string; canonEveryMin: number; log: (s: string) => void }): Promise<Brain> {
  const pool = getPool();
  await waitForDb(pool);
  await runMigrations(pool, { log: (s) => opts.log(`migration ${s}`) });
  const ids = await ensureHqBrain(pool);
  const memory = new BrainMemoryStore(pool, ids);
  await importLegacyMemories(memory, opts.dataDir, opts.log);

  let syncing = false;
  const syncCanon = async () => {
    if (!opts.vault || syncing) return null;
    syncing = true;
    try {
      const r = await syncVaultCanon(pool, ids.workspaceId, opts.vault);
      if (r.added || r.updated || r.removed) opts.log(`vault canon: ${r.added} added, ${r.updated} updated, ${r.removed} removed`);
      for (const s of r.skipped) opts.log(`vault canon skipped ${s}`);
      return r;
    } finally {
      syncing = false;
    }
  };
  await syncCanon().catch((e) => opts.log(`vault canon sync failed: ${e instanceof Error ? e.message : e}`));
  const timer = setInterval(
    () => void syncCanon().catch((e) => opts.log(`vault canon sync failed: ${e instanceof Error ? e.message : e}`)),
    Math.max(1, opts.canonEveryMin) * 60_000,
  );
  timer.unref();

  return { ids, memory, syncCanon, stop: () => clearInterval(timer) };
}
