# Mission Control — HQ upgrade

These changes add the features from Mark Kashef's Claude Code "command center" to
your existing Mission Control. Your UI, the `/api/agent/*` routes, the legacy
`/command` and `/stream` routes used by voice Jarvis, and the eval suite all keep working.

## What's new

| Feature | Where | Notes |
|---|---|---|
| **Delegation** | `src/hq/team.ts`, `src/ui.ts` | Jarvis (planner) can hand parts of a job to coder, browser, file and security_audit by writing `@coder: …` lines. Each teammate's output streams into the same task under its own header, then Jarvis writes the combined final answer. |
| **Auto-routing** | `routeTask` in `team.ts` | New `auto` choice (now the dashboard default). A quick call to `OLLAMA_FAST_MODEL` picks the agent; keyword fallback if Ollama is down. |
| **Hive mind** | `src/hq/hive.ts` | Shared activity log (routing, handoffs, results) injected into every agent's prompt. Saved to `data/hive.json`. **Hive Mind** tab on the dashboard. |
| **Memory** | `src/hq/memory.ts` | Facts are extracted between tasks (never while one is running), recalled by relevance, and every 30 min unpinned memories decay, faded ones are forgotten and duplicates merge. **Memory** tab: add, pin, delete, tidy. Saved to `data/memories.json`. |
| **Obsidian** | `vaultNotes` / `saveNotes` | Agents read `HQ/shared.md` and `HQ/agents/<agent>.md` from your vault. The file agent can save notes to `HQ/inbox/`. |
| **Exfiltration guard** | `src/hq/guard.ts` | API keys, tokens, private keys and `password=` values are redacted from the live stream (even when split across token batches), the hive log, memories, notes and Telegram. |
| **Telegram** | `src/hq/telegram.ts` | Long-polling bot with a chat ID allowlist. `/coder …` picks an agent, `/status` shows the queue. Answers come back when the task finishes. |

| **Prompt caching** | `teamContext` / `withLiveContext` | The system prompt holds only text that stays the same between calls (persona, team, rules, vault notes), so Ollama reuses its cached work for it. The hive log and memories, which change every call, travel with the request instead. |
| **No silent thinking** | `makeJsonChat` in `src/hq/ollama.ts` | Routing and memory calls send `think: false` to models that support it, so qwen3 answers right away instead of reasoning first. |
| **Preflight** | `scripts/preflight.ts` | `npm run preflight` checks the whole chain and prints a latency budget (see below). |

Behaviour kept on purpose:
- **Evals** (`source: "eval"`) get the bare prompts: no team context, no delegation, and they stay out of the hive, so scores stay comparable with your earlier results.
- **Voice** tasks get team context and memory but never delegate, so Jarvis still gives one short spoken answer.
- API clients that send no `targetAgent` still default to `planner`. Only the dashboard defaults to `auto`.

## Install

From the copy in `C:\Users\aldra\Documents\mission-control-src`, back into WSL:

```bash
rsync -a --exclude .env /mnt/c/Users/aldra/Documents/mission-control-src/ ~/sandcastle/ts-harness/
cd ~/sandcastle/ts-harness
ollama pull qwen3:4b        # on Windows: the routing/memory model (optional)
docker compose up -d --force-recreate
```

Add to `.env` as needed: `OLLAMA_FAST_MODEL=qwen3:4b`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_ALLOWED_CHAT_IDS`. For Obsidian, uncomment the two vault lines in `docker-compose.yml`.

## New API

| Method | Path | |
|---|---|---|
| POST | `/api/agent/run` | `targetAgent` now also accepts `"auto"` |
| GET | `/api/agents` | the team |
| GET | `/api/hive?limit=100` | shared activity log |
| GET / POST | `/api/memories` | list / add `{text, pinned}` |
| POST | `/api/memories/:id/pin\|unpin\|delete`, `/api/memories/maintain` | |

New stream statuses: `routing`, `delegating`. New task fields: `routedBy`, `delegatedTo`.
New task source: `telegram`.

## Preflight

```bash
docker compose exec harness npm run preflight
```

It checks, in order: Ollama is reachable, both models are installed, generation
speed and first-token time, whether the prompt cache is being reused, how much of
the model sits in VRAM, the routing model, a real task through the harness queue,
a memory write and read-back, and (if `VOICE_TTS_URL` and `VOICE_STT_URL` are
set) a voice round trip that speaks a phrase and transcribes it back. It ends with:

```
Latency budget: hear 0.8s · think 2.1s (first token 0.4s, 38 tok/s) · speak 0.6s  =  3.5s per spoken turn
```

Every check prints a fix when it warns or fails (for example `ollama pull qwen3:4b`,
or "part runs on CPU: lower OLLAMA_NUM_CTX"). Exit code 1 if anything fails.

## Tests

```bash
npm test        # HQ unit tests, no Ollama needed
npm run eval    # your existing eval suite, unchanged
```
