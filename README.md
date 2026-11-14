# GAMFace HQ

A local, multi-agent Mission Control inspired by Mark Kashef's Claude Code
"command center", rebuilt to run entirely on your own PC with Ollama.

- **Five agents that delegate to each other.** Jarvis (lead) breaks big jobs up and
  hands pieces to Forge (coder), Atlas (researcher), Archive (notes/Obsidian) and
  Sentinel (security), then combines their results.
- **Auto-routing.** Leave the dropdown on *Auto* and a quick model call picks the agent
  (keyword fallback if the model is down).
- **Hive mind.** Every agent sees a shared log of what the whole team has been doing.
- **Sequential queue.** One task at a time on the GPU; failures retry once and are always
  recorded, never silent. Tasks survive a restart.
- **Memory.** Durable facts are extracted after each task, recalled by relevance, and every
  30 minutes unpinned memories decay, stale ones are forgotten and duplicates merge.
  Pin anything you want kept forever.
- **Obsidian.** Agents read `HQ/shared.md` and `HQ/agents/<agent>.md` from your vault;
  Archive saves notes to `HQ/inbox/`.
- **Telegram** front end with a chat ID allowlist.
- **Exfiltration guard.** API keys, tokens and private keys are redacted from every
  answer before it is shown or sent.
- **Optional agenticSeek bridge.** Set `AGENTICSEEK_URL` and an *Operator* agent forwards
  hands-on tasks (web, files, shell) to your existing agenticSeek backend.

No packages to install: it is plain Python 3.10+ (standard library only).

## Run it

```powershell
git clone https://github.com/Gamface/GAMFace-HQ.git
cd GAMFace-HQ
copy .env.example .env      # then edit: OLLAMA_URL=http://127.0.0.1:11435 for your setup
ollama pull qwen3:4b         # optional fast model for routing + memory
python -m hq.server
```

Open http://127.0.0.1:3030. It runs alongside your existing Mission Control (port 5173/3010).

**Start at login:** `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`

**Telegram:** create a bot with @BotFather, put the token in `TELEGRAM_BOT_TOKEN`, start HQ,
message the bot. It replies with your chat ID; add it to `TELEGRAM_ALLOWED_CHAT_IDS` and restart.
Commands: any text (auto-routed), `/coder ...` etc. to pick an agent, `/status` for the queue.

**Phone access:** install Tailscale on the PC and phone, set `HQ_HOST=0.0.0.0`, and open
`http://<pc-tailscale-name>:3030`. Don't expose it to the open internet.

## How a task flows

```
dashboard / Telegram → queue (SQLite) → router → agent
   agent prompt = role + team roster + hive log + recalled memories + vault notes
   agent replies JSON: {"reply": ..., "delegate": [{"agent": ..., "task": ...}]}
   delegations become sub-tasks → run → parent re-queued → lead combines results
   → exfiltration guard → dashboard / Telegram reply → memory extraction
```

## API

| Method | Path | |
|---|---|---|
| GET | `/api/system` | Ollama status, GPU use, queue |
| GET/POST | `/api/tasks` | list / create `{prompt, agent}` (`agent` = `auto` or a key) |
| GET | `/api/tasks/{id}` | task with its sub-tasks |
| POST | `/api/tasks/{id}/cancel` | cancel |
| GET | `/api/hive` | shared activity log |
| GET | `/api/events` | live server-sent events |
| GET/POST | `/api/memories` | list / add `{text, pinned}` |
| POST | `/api/memories/{id}/pin\|unpin\|delete`, `/api/memories/maintain` | |

## Tests

```
python -m unittest -v
```

The tests use a scripted fake model, so they run without Ollama.

## Not built yet

- **Voice War Room** (Pipecat + Faster-Whisper + Piper feeding this queue)
- **Scheduled tasks** (recurring prompts on a timer)
