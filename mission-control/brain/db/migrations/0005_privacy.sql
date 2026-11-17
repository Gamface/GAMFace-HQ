-- Private content stays away from cloud models.
--
-- A row marked private is only served to clients whose token has
-- allow_private (local clients such as GAMFace HQ itself). Cloud clients
-- (Claude Code, a hosted harness) see only rows with private = false.
-- Everything starts private; sharing is a deliberate choice.

ALTER TABLE api_tokens ADD COLUMN allow_private BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE memories     ADD COLUMN private BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE canon_docs   ADD COLUMN private BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE kg_entities  ADD COLUMN private BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE kg_relations ADD COLUMN private BOOLEAN NOT NULL DEFAULT TRUE;

-- Canon docs synced from files (the Obsidian vault's HQ/ folder) remember
-- where they came from, so edits update them and deleted files remove them.
ALTER TABLE canon_docs ADD COLUMN source_path TEXT;
ALTER TABLE canon_docs ADD COLUMN source_hash TEXT;
CREATE UNIQUE INDEX uq_canon_docs_source ON canon_docs (workspace_id, source_path) WHERE source_path IS NOT NULL;
