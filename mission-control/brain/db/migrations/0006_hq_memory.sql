-- GAMFace HQ's own memories ("facts") live in the brain alongside notes,
-- run conclusions and learnings. HQ keeps its bookkeeping in metadata:
--   hq_agent   "shared" or the HQ agent that owns it
--   importance 0..1, decays with disuse unless pinned
--   pinned     never decays or gets forgotten
--   hits, last_used (ms since epoch)
--   legacy_id  id in the old data/memories.json, for a one-time import
ALTER TABLE memories DROP CONSTRAINT memories_kind_check;
ALTER TABLE memories ADD CONSTRAINT memories_kind_check
    CHECK (kind IN ('vault_note', 'learning', 'run_conclusion', 'fact'));

CREATE INDEX idx_memories_hq_facts ON memories (workspace_id, department_id) WHERE kind = 'fact';
CREATE UNIQUE INDEX uq_memories_legacy_id ON memories (workspace_id, (metadata->>'legacy_id'))
    WHERE (metadata->>'legacy_id') IS NOT NULL;
