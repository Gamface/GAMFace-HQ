-- Index only live memories. search_memory filters on exactly this predicate,
-- so the planner uses the smaller index and the HNSW graph never walks
-- rejected, pending or superseded rows.
DROP INDEX IF EXISTS idx_memories_embedding;
CREATE INDEX idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops)
    WHERE status = 'approved' AND superseded_by IS NULL;
