-- Replace the all-or-nothing can_switch_agents flag with a per-token list of
-- personas the client may activate. The token's default agent is always
-- allowed. '{*}' = any agent in the workspace; '{}' = default agent only.
ALTER TABLE api_tokens ADD COLUMN allowed_agent_slugs TEXT[] NOT NULL DEFAULT '{}';
UPDATE api_tokens SET allowed_agent_slugs = '{*}' WHERE can_switch_agents;
ALTER TABLE api_tokens DROP COLUMN can_switch_agents;

-- When each client last used its token (written at most every 5 minutes).
ALTER TABLE api_tokens ADD COLUMN last_used_at TIMESTAMPTZ;
