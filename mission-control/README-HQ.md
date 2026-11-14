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

| **Code preview** | `ui/src/components/PreviewPane.tsx` | **Preview** tab renders the HTML, CSS and JavaScript from the selected task in a sandboxed frame (no access to Mission Control). Reload, open in a new tab, copy the HTML, or show the code blocks. Other languages are listed but not run. |
| **Visible browser** | `src/hq/browser.ts`, `src/hq/browser-agent.ts`, `ui/src/components/BrowserPane.tsx` | The browser agent now drives a real headless Chrome (its own container) step by step: open, click, type, scroll, back, then answer with its sources. The **Browser** tab shows the live screen, the address bar and every action, and opens by itself when browsing starts. Works for direct tasks and when Jarvis delegates to the browser. |
| **Prompt caching** | `teamContext` / `withLiveContext` | The system prompt holds only text that stays the same between calls (persona, team, rules, vault notes), so Ollama reuses its cached work for it. The hive log and memories, which change every call, travel with the request instead. |
| **No silent thinking** | `makeJsonChat` in `src/hq/ollama.ts` | Routing and memory calls send `think: false` to models that support it, so qwen3 answers right away instead of reasoning first. |
| **Preflight** | `scripts/preflight.ts` | `npm run preflight` checks the whole chain and prints a latency budget (see below). |

## Board, per-agent models and saved history (Phases 0–2)

**Saved history (Phase 0).** Tasks, their output and settings live in `data/mission-control.db`
(Node's built-in SQLite, no packages). A restart loses nothing: queued cards carry on, and a
run that was cut off mid-way comes back in **Failed** marked *interrupted*, waiting for you to
press **Retry**. It isn't re-run on its own.

**A different model for each agent (Phase 1).** On the **Team** page each agent (Jarvis,
Coder, Browser, File, Security, plus the Router and Memory helpers) gets:
- a model from any provider: `ollama/…` (local GPU), `lmstudio/…`, or a cloud provider once its
  key is in `.env` (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`),
  or any OpenAI-compatible server you add (vLLM, Groq, a second Ollama…);
- a **fallback** used if the model fails before answering, or once a cloud model passes its
  **daily token cap**;
- context size, temperature and thinking on/off;
- today's token use.

Keys are only ever read from `.env`; the database and dashboard never see them. Delegated
handoffs use each teammate's own model (the output header says which). Say or type
`switch to claude`, `switch coder to local`, `use openrouter/x for the browser` or `go local`
in the dashboard, Telegram or voice; nicknames like `claude` are set on the Team page.
Your one GPU can only hold so much, so the queue prefers a card that uses the model already
loaded (for at most `MODEL_GROUP_MAX_WAIT_MS`, default 60 s). Setting
`OLLAMA_MAX_LOADED_MODELS=2` for Ollama on Windows keeps the main and helper models loaded together.

**Kanban board (Phase 2).** The **Board** view has Backlog → Ready → Running → Review → Done / Failed.
- **+ New card**: task, agent (or auto-route), priority, cards it waits for, and whether you
  want to review the result. Park it in Backlog or queue it in Ready.
- **Drag** Backlog ⇄ Ready to queue or park, Review → Done to accept, Failed/Done → Ready to
  run again. Drop a card on another card to reorder. Ready runs by priority, then board order.
- **Dependencies**: a card waits until the cards it depends on are done (and accepted, if they
  need review). Dependency loops are refused.
- **Card panel** (click a card): status, agent and model, each handoff with its own model and
  answer, the full output, the code preview, and the actions that fit (Queue, Edit, Accept,
  Retry, Cancel, Remove).
- Tasks from the console, Telegram, voice and the API all appear on the board too.

Board API: `GET /api/board`, `POST /api/tasks` (`title`, `prompt`, `targetAgent`, `priority`,
`dependsOn`, `needsReview`, `column`), `PATCH /api/tasks/:id`, `POST /api/tasks/:id/retry|accept|archive`.
Models API: `GET /api/models`, `PUT /api/models`, `GET /api/models/available?provider=…`, `GET /api/models/check`.

Browser safety:
- Every request the page makes (navigations, redirects, images, scripts) is checked; anything aimed at localhost, `*.local` or your private network (10.x, 172.16–31.x, 192.168.x, Tailscale 100.64.x) is blocked, so a web page can't steer the agent into your router, Proxmox or the harness.
- Page text is passed to the model as untrusted data, and the agent is told never to sign in, enter passwords, payment or personal details, buy or post.
- Chrome runs in its own container with no port published to your PC, at most `BROWSER_MAX_STEPS` actions per task (default 10).
- If Chrome isn't running, the browser agent says so and answers without it.

Behaviour kept on purpose:
- **Evals** (`source: "eval"`) get the bare prompts: no team context, no delegation, no real browsing, and they stay out of the hive, so scores stay comparable with your earlier results.
- **Voice** tasks get team context and memory but never delegate, so Jarvis still gives one short spoken answer.
- API clients that send no `targetAgent` still default to `planner`. Only the dashboard defaults to `auto`.

## Install

From the copy in `C:\Users\aldra\Documents\mission-control-src`, back into WSL:

```bash
rsync -a --exclude .env /mnt/c/Users/aldra/Documents/mission-control-src/ ~/sandcastle/ts-harness/
cd ~/sandcastle/ts-harness
ollama pull qwen3:4b        # on Windows: the routing/memory model (optional)
docker compose up -d --force-recreate     # also starts the Chrome container
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
npm test        # HQ unit tests (20), no Ollama needed
npm run eval    # your existing eval suite, unchanged
```
