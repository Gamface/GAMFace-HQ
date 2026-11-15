-- Agent OS / Company Brain schema (v1)
-- Single Postgres + pgvector store. Every table carries workspace_id.
-- Scope rules are enforced by the MCP server from the session's agent identity;
-- tool arguments never choose workspace, department or project.

CREATE EXTENSION IF NOT EXISTS vector;
-- gen_random_uuid() is built in (PG13+); no uuid-ossp needed.

-- ---------------------------------------------------------------------------
-- 1. Workspaces and organisation
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE departments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    slug          TEXT NOT NULL,
    name          TEXT NOT NULL,
    UNIQUE (workspace_id, slug)
);

CREATE TABLE projects (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    department_id  UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    slug           TEXT NOT NULL,
    name           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
    UNIQUE (workspace_id, slug),
    UNIQUE (id, department_id)   -- target for the composite FKs below
);

-- ---------------------------------------------------------------------------
-- 2. Agents and versioned prompts
-- ---------------------------------------------------------------------------
CREATE TABLE agents (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id           UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    department_id          UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    project_id             UUID,
    slug                   TEXT NOT NULL,
    name                   TEXT NOT NULL,
    role                   TEXT NOT NULL,
    active_prompt_version  INT  NOT NULL DEFAULT 1,
    -- '{*}' = every tool; '{}' = no tools except activate_agent.
    allowed_tools          TEXT[] NOT NULL DEFAULT '{}',
    -- Server-side policy (NOT a tool argument): may this agent's own prompt
    -- edits go live without human review? Default: no.
    prompt_auto_approve    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, slug),
    -- An agent's project must belong to the agent's department.
    FOREIGN KEY (project_id, department_id) REFERENCES projects (id, department_id)
        ON DELETE SET NULL (project_id)
);

CREATE TABLE agent_prompt_versions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id       UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    version        INT  NOT NULL,
    instructions   TEXT NOT NULL,
    change_reason  TEXT,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_by     TEXT NOT NULL,          -- 'human' or the agent slug
    reviewed_by    TEXT,
    reviewed_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, version)
);

-- One token per MCP client (Claude Code, voice agent, cron runner, ...).
-- Only the SHA-256 hex digest of the token is stored.
CREATE TABLE api_tokens (
    token_hash         TEXT PRIMARY KEY,
    workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    default_agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    client_label       TEXT NOT NULL,
    can_switch_agents  BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. Tier 1 memory: canon (core business docs; index in prompt, body on demand)
-- ---------------------------------------------------------------------------
CREATE TABLE canon_docs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    department_id  UUID REFERENCES departments(id) ON DELETE CASCADE,   -- NULL = whole workspace
    slug           TEXT NOT NULL,
    title          TEXT NOT NULL,
    summary        TEXT NOT NULL,
    content        TEXT NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, slug)
);

-- ---------------------------------------------------------------------------
-- 4. Tier 2 memory: notes, run conclusions, learnings (vector + keyword)
-- ---------------------------------------------------------------------------
CREATE TABLE memories (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    department_id    UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,  -- owning department
    project_id       UUID,
    agent_id         UUID REFERENCES agents(id) ON DELETE SET NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('vault_note', 'learning', 'run_conclusion')),
    scope            TEXT NOT NULL CHECK (scope IN ('agent', 'project', 'department', 'global')),
    status           TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
    title            TEXT NOT NULL,
    content          TEXT NOT NULL,
    search_tsv       TSVECTOR GENERATED ALWAYS AS (
                         to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
                     ) STORED,
    embedding        VECTOR(768),          -- nomic-embed-text; change with EMBED_DIMS
    embedding_model  TEXT,
    embedding_dims   INT,
    superseded_by    UUID REFERENCES memories(id) ON DELETE SET NULL,
    reviewed_by      TEXT,
    reviewed_at      TIMESTAMPTZ,
    metadata         JSONB NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A project-scoped row must name its project; an agent-scoped row its agent.
    CONSTRAINT memories_project_scope_has_project CHECK (scope <> 'project' OR project_id IS NOT NULL),
    CONSTRAINT memories_agent_scope_has_agent     CHECK (scope <> 'agent'   OR agent_id   IS NOT NULL),
    -- A memory's project must belong to its department. Moving a project to
    -- another department is blocked until its agents and memories are handled.
    CONSTRAINT memories_project_in_department FOREIGN KEY (project_id, department_id)
        REFERENCES projects (id, department_id)
);

CREATE INDEX idx_memories_tsv       ON memories USING GIN (search_tsv);
CREATE INDEX idx_memories_scope     ON memories (workspace_id, scope, department_id, project_id, agent_id)
    WHERE status = 'approved' AND superseded_by IS NULL;
CREATE INDEX idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 5. Knowledge graph (department-scoped)
-- ---------------------------------------------------------------------------
CREATE TABLE kg_entities (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    department_id  UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    project_id     UUID REFERENCES projects(id) ON DELETE SET NULL,
    entity_type    TEXT NOT NULL,          -- person, company, tool, concept, ...
    name           TEXT NOT NULL,
    -- Same parser as memory search, so query words and entity names match.
    name_tsv       TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', name)) STORED,
    attributes     JSONB NOT NULL DEFAULT '{}',
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_kg_entities_name
    ON kg_entities (workspace_id, department_id, entity_type, (lower(name)));
CREATE INDEX idx_kg_entities_tsv ON kg_entities USING GIN (name_tsv);

CREATE TABLE kg_relations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    department_id       UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    source_entity_id    UUID NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
    relation_type       TEXT NOT NULL,     -- works_at, competitor_of, uses, ...
    target_entity_id    UUID NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
    evidence_memory_id  UUID REFERENCES memories(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_entity_id, relation_type, target_entity_id)
);

CREATE INDEX idx_kg_relations_target ON kg_relations (target_entity_id);

-- ---------------------------------------------------------------------------
-- 6. Trackers (structured rows instead of loose markdown)
-- ---------------------------------------------------------------------------
CREATE TABLE tracker_rows (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    department_id        UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    project_id           UUID REFERENCES projects(id) ON DELETE SET NULL,
    tracker_name         TEXT NOT NULL,    -- seo_competitors, outbound_leads, ...
    row_key              TEXT NOT NULL,    -- natural key: domain, email, ...
    data                 JSONB NOT NULL,
    updated_by_agent_id  UUID REFERENCES agents(id) ON DELETE SET NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- department_id is part of the key: an agent can never collide with
    -- (and overwrite) another department's row.
    UNIQUE (workspace_id, department_id, tracker_name, row_key)
);

-- ---------------------------------------------------------------------------
-- 7. Audit log (every tool call: ok, denied or error)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id       UUID REFERENCES agents(id) ON DELETE SET NULL,
    client_label   TEXT NOT NULL,
    session_id     TEXT,
    tool_name      TEXT NOT NULL,
    input_summary  JSONB,
    status         TEXT NOT NULL CHECK (status IN ('ok', 'denied', 'error')),
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_recent ON audit_logs (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 8. Review queue + review functions (for you, not for agents)
-- ---------------------------------------------------------------------------
CREATE VIEW pending_reviews AS
SELECT 'prompt'::text AS item_type, v.id, a.workspace_id, a.slug AS agent_slug,
       ('v' || v.version)::text AS title, v.change_reason AS detail, v.created_at
FROM agent_prompt_versions v JOIN agents a ON a.id = v.agent_id
WHERE v.status = 'pending'
UNION ALL
SELECT 'learning', m.id, m.workspace_id, a.slug, m.title, m.scope || ': ' || left(m.content, 200), m.created_at
FROM memories m LEFT JOIN agents a ON a.id = m.agent_id
WHERE m.status = 'pending'
ORDER BY created_at;

-- Approve a prompt version and make it the agent's active prompt.
CREATE FUNCTION approve_prompt_version(p_version_id UUID, p_reviewer TEXT DEFAULT 'human')
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_agent UUID; v_ver INT;
BEGIN
    UPDATE agent_prompt_versions
       SET status = 'approved', reviewed_by = p_reviewer, reviewed_at = now()
     WHERE id = p_version_id AND status = 'pending'
    RETURNING agent_id, version INTO v_agent, v_ver;
    IF v_agent IS NULL THEN
        RAISE EXCEPTION 'No pending prompt version %', p_version_id;
    END IF;
    UPDATE agents SET active_prompt_version = v_ver WHERE id = v_agent;
END $$;

CREATE FUNCTION reject_prompt_version(p_version_id UUID, p_reviewer TEXT DEFAULT 'human')
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    UPDATE agent_prompt_versions
       SET status = 'rejected', reviewed_by = p_reviewer, reviewed_at = now()
     WHERE id = p_version_id AND status = 'pending';
    IF NOT FOUND THEN RAISE EXCEPTION 'No pending prompt version %', p_version_id; END IF;
END $$;

-- Roll back: point the agent at an earlier approved version.
CREATE FUNCTION rollback_prompt(p_agent_id UUID, p_version INT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM agent_prompt_versions
     WHERE agent_id = p_agent_id AND version = p_version AND status = 'approved';
    IF NOT FOUND THEN RAISE EXCEPTION 'Version % is not an approved version of agent %', p_version, p_agent_id; END IF;
    UPDATE agents SET active_prompt_version = p_version WHERE id = p_agent_id;
END $$;

-- Approve or reject a pending learning.
CREATE FUNCTION review_learning(p_memory_id UUID, p_approve BOOLEAN, p_reviewer TEXT DEFAULT 'human')
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    UPDATE memories
       SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
           reviewed_by = p_reviewer, reviewed_at = now()
     WHERE id = p_memory_id AND status = 'pending';
    IF NOT FOUND THEN RAISE EXCEPTION 'No pending learning %', p_memory_id; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Read-only access for NocoDB (role created in 00-init-roles.sh)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nocodb_ro') THEN
        GRANT USAGE ON SCHEMA public TO nocodb_ro;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO nocodb_ro;
        -- api_tokens holds credential hashes; keep them out of the viewer.
        REVOKE SELECT ON api_tokens FROM nocodb_ro;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO nocodb_ro;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 10. Migration tracking. Later changes live in db/migrations/ and are applied
--     with `npm run db:migrate`; this file is the v1 baseline.
-- ---------------------------------------------------------------------------
CREATE TABLE schema_migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (id) VALUES ('0000_baseline');
