# The brain: shared memory for HQ and outside agents

Mission Control's memory now lives in a Postgres + pgvector database (the
`brain-db` container) instead of `data/memories.json`. HQ's agents use it
directly; outside clients such as Claude Code reach the same memory over MCP
at `http://localhost:3010/mcp`, each with its own token. It started as the
"Agent OS" design and keeps its pieces: scoped memory with vector + keyword
search, canon documents, a knowledge graph, trackers, prompt versions with
review, and an audit log.

```
brain/db/schema.sql        baseline, loaded on the database's first start
brain/db/migrations/       later changes, applied every time the harness starts
src/brain/index.ts         startup: migrations, HQ's agents, memory, vault sync
src/brain/memory-store.ts  HQ's memory on the brain (+ one-time import)
src/brain/canon-sync.ts    vault HQ/ notes → canon docs
src/brain/mcp-server.ts    the MCP endpoint for outside clients
src/brain/token.ts         npm run brain:token
```

## Set up

1. In `mission-control/.env` set `BRAIN_DB_PASSWORD` (`openssl rand -hex 32`).
   Compose refuses to start without it.
2. Pull the embedding model on your Ollama: `ollama pull nomic-embed-text`.
3. `docker compose up -d`. On its first start the harness creates the
   database tables, HQ's agents and Claude Code's agent, imports
   `data/memories.json` once (renamed to `memories.imported-<date>.json` as a
   backup), and copies the vault's `HQ/` notes into canon docs. The log shows
   each step (`docker compose logs harness | grep brain`).

If the database isn't reachable, the harness stops instead of running without
its memory; Docker restarts it.

## Connect Claude Code

```bash
docker compose exec harness npm run brain:token -- claude-code
```

It prints a token (shown once) and the command to run on your PC:

```bash
claude mcp add --transport http --scope user gamface-brain http://localhost:3010/mcp --header "Authorization: Bearer <token>"
```

In Claude Code, ask it to call `activate_agent`. It then has `search_memory`,
`read_canon_doc`, `file_to_vault`, `record_learning` and `upsert_tracker_row`.
Its run conclusions show up in HQ agents' recalled memories, and HQ's shared
memories show up in its searches. Revoke with
`npm run brain:token -- claude-code --revoke`.

## Private vs shared

Claude Code's model runs in the cloud, so it only ever sees **shared** content.
The same rule HQ applies to its own cloud agents now applies over MCP:

| Content | Starts as | Shared when |
|---|---|---|
| HQ memories from a task that used vault notes, memories, pictures or audio | private | you click **Share** in the Memory panel |
| HQ memories from a task that used none of those | shared | (click **Make private** to hide one) |
| Memories you add by hand, and everything imported from memories.json | private | you click **Share** |
| Vault notes in `HQ/` | private | the note's frontmatter has `cloud: true` |
| Notes Claude Code files | shared (it already saw them) | — |
| Graph entities | private | any shared memory mentions them |

A token created with `--allow-private` can read private content too. Use it only
for clients whose model runs on your own hardware. Inside HQ nothing changed:
recalled memories and vault notes still never reach a cloud model unless that
agent has **Private → cloud** turned on.

## Vault notes as canon

Every `.md` file under the vault's `HQ/` folder becomes a canon doc, except
`HQ/inbox/` and `HQ/routines/` (agent output). The sync runs at startup and
every `CANON_SYNC_MIN` minutes (default 5); `POST /api/brain/sync-canon` runs it
now. Edits update the canon doc and deleted notes remove it. The vault stays the
source; HQ's agents still read `HQ/shared.md` and `HQ/agents/<agent>.md`
directly as before.

```markdown
---
cloud: true
title: Coding standards
summary: How we write TypeScript here
---
```

`title` and `summary` are optional (the first `#` heading and first paragraph
are used otherwise).

## Everyday commands

```bash
docker compose exec harness npm run brain:migrate -- --status   # applied / pending migrations
docker compose exec harness npm run brain:backfill              # add vectors to rows saved while Ollama was down
docker compose exec harness npm run brain:token -- <label> [--agent slug] [--agents a,b|*] [--allow-private] [--revoke]
curl http://localhost:3010/api/brain                            # status
```

Pending prompt edits and learnings from agents wait for you:
`docker compose exec brain-db psql -U agentos -d agent_brain -c "SELECT * FROM pending_reviews"`,
then `SELECT approve_prompt_version('<id>')` or `SELECT review_learning('<id>', true)`.

**Viewer (optional):** set `NOCODB_META_PASSWORD`, `NOCODB_RO_PASSWORD` and
`NC_AUTH_JWT_SECRET` before the database's first start, then
`docker compose --profile viewer up -d` and open http://localhost:8081. Add a
PostgreSQL source: host `brain-db`, database `agent_brain`, user `nocodb_ro`.
It can read everything except tokens and can't write.

## Tests

`npm test` covers the parts that need no database. The database tests run
against a throwaway Postgres with pgvector:

```bash
BRAIN_TEST_DATABASE_URL=postgres://agentos:pw@localhost:5432/agent_brain_test npm run test:brain
```

## HQ projects

Each HQ fact may belong to a Mission Control project, kept in
`metadata.hq_project` (missing means General). HQ's recall in a project returns
that project's facts plus General ones, never another project's; rows written by
other clients (notes, run conclusions) have no project and count as General.
Deleting a project deletes its facts. No migration is needed: the field lives in
the existing `metadata` column.
