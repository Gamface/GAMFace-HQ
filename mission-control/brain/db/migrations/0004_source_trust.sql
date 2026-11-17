-- Mark content that came from outside sources (web pages, emails, scraped
-- profiles). search_memory wraps such rows in <untrusted_data> tags so
-- instructions hidden in them are presented to agents as data.
ALTER TABLE memories
    ADD COLUMN source_trust TEXT NOT NULL DEFAULT 'internal'
    CHECK (source_trust IN ('internal', 'external_untrusted'));

-- Tracker rows are mostly enriched or scraped records: untrusted by default.
ALTER TABLE tracker_rows
    ADD COLUMN source_trust TEXT NOT NULL DEFAULT 'external_untrusted'
    CHECK (source_trust IN ('internal', 'external_untrusted'));

-- Rows saved while the embedding service was down, waiting for db:backfill.
CREATE INDEX idx_memories_missing_embedding ON memories (created_at) WHERE embedding IS NULL;
