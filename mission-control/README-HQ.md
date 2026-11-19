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

**Local models with colibri.** [colibri](https://github.com/JustVugg/colibri) runs large
mixture-of-experts models on your own PC, keeping rarely used experts on disk. Set
`COLIBRI_BASE_URL` in `.env` (from the container: `http://host.docker.internal:<port>/v1`) and
`colibri/…` models appear on the Team page as a **local** provider, so the local-only lock and
the private-context rule treat them like Ollama. `COLIBRI_MODEL` and `COLIBRI_BIG_MODEL` add the
nicknames `colibri` and `colibri-big` (`switch Jarvis to colibri`).
- Link the models you already have in Ollama with colibri's model linker instead of
  downloading them again.
- A mid-size model held in RAM/VRAM answers at interactive speed. A very large one streamed
  from disk manages about 1–1.5 words a second on a fast internal NVMe drive (far less on SATA
  or USB), so give that agent a **Time limit** on the Team page (minutes; it overrides
  `TASK_TIMEOUT_MS` for that agent's cards, and Jarvis gets the longest limit of his team).
- Router and Memory stay on the small Ollama model, so background calls never push the big
  model's cached prompt out.

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

## Brain: shared memory with Claude Code

Memory lives in the `brain-db` Postgres container, shared with outside agents over MCP
at `http://localhost:3010/mcp`. On first start your old `data/memories.json` is imported
once, and the vault's `HQ/` notes are copied into canon docs (kept in sync every few
minutes). Set `BRAIN_DB_PASSWORD` in `.env` and `ollama pull nomic-embed-text` first.
Connect Claude Code with `docker compose exec harness npm run brain:token -- claude-code`.
Cloud clients only see memories and notes you've shared: **Share** in the Memory panel,
or `cloud: true` in a note's frontmatter (on Home too). Projects carry over: a memory
learned in a project is only recalled there (and General ones everywhere), and a project
kept on this PC keeps all its memories private. Move one with
`POST /api/memories/:id/move {"project": "<id>" | null}`. Details: [brain/README.md](brain/README.md).

## Privacy, spend caps and read-only runs

Every model request, including routing, memory, browser steps, delegation,
synthesis and every fallback, goes through one gateway (`src/hq/gateway.ts`).
On each request it applies, in order:

1. **Local-only lock.** Agents marked *Local only* (File and Memory by default) never
   reach a cloud provider. The Team page and `switch file to claude` refuse it, and the
   gateway refuses it again at send time, so no code path can get around it.
2. **Spend caps.** Set a price per cloud model ($ per million input and output tokens),
   a monthly cap per agent, and an overall monthly cap. The gateway checks before each
   request, counting what's already spent this month plus an estimate of this request's
   input cost, and records the real cost of input and output tokens afterwards.
   **At the cap, the agent uses its local model instead**, the card's output says so, and
   a notice appears in the dashboard header. A capped agent whose cloud model has no
   price set also goes local, rather than spending without a limit. Until you save an
   overall cap on the Team page, a default of $20 a month applies (`MONTHLY_BUDGET_USD`
   in `.env`; `none` for no default). Clearing the field on the Team page means no cap.
   A daily token cap with no fallback model sends the agent to the default local model.
   **Private handoffs:** when a lead's turn included private material, the teammates it
   delegates to stay on a local model too, unless *Private → cloud* is ticked for them.
3. **Private-context rule.** Vault notes, memories and the hive log are marked private
   where they enter a prompt. Local models get them in full; cloud models get a stand-in:
   the hive as bare activity (who did what, no details), no memories and no vault notes,
   unless you tick *Private → cloud* for that agent. Anything an agent wrote **after**
   seeing private material is private too: if a local teammate answered from your notes,
   that answer is withheld when a cloud lead combines the results, and memory extraction
   never shows a cloud model an answer written from private material. Cards that used
   private context show 🔒.

**Read-only runs** (tick *Read-only run* on a card; routines will use this until the
approval rules in Phase 4 exist):
- the browser gets a **fresh profile** for the run, so it is never logged in anywhere;
- pages may only be opened on the card's **allowed sites** (or the sites named in the task),
  plus web search; links to other sites are refused, so a one-click unsubscribe, logout or
  "confirm" link elsewhere can't fire; a search result is opened only if it leads to an
  allowed site, and a run with no sites named can read search results but open none;
- **no typing, no buttons**: clicks only follow links;
- the browser blocks **every request that isn't a plain page load** (no form submits, no
  data sent by page scripts);
- no notes are written to the vault and no memories are saved.

**Routine runs** (cards with source `routine`) are always read-only: the server forces it
when the card is created, refuses edits that would switch it off, and checks again when it
runs. Each has one destination (`deliverTo`: `dashboard`, `telegram` or `obsidian`, a note
in `HQ/routines`); its prompt can't switch models, and its findings stay on its card rather
than in the hive log. Rules: `src/hq/routine.ts`.

## Videos with Remotion

Ask for a video ("make a 20-second intro video for my channel", "create an animated logo",
"use Remotion to…") and the **Coder** writes a Remotion scene: one React/TypeScript file.
Mission Control sends it to the **video service**, which renders it with real Remotion
into an MP4 that appears on the card (🎬): play it there or download it.
- If Remotion can't render the scene, the error goes back to the Coder to fix, up to twice
  (`VIDEO_FIX_ROUNDS`). Reply to the card ("make the title bigger") and it renders again;
  **🎬 Render again** on the card re-renders without asking the model.
- Limits: at most 1920×1080 (portrait is fine), 60 fps and `VIDEO_MAX_SECONDS` (60).
  Scenes can use `remotion`, `@remotion/transitions`, `@remotion/shapes`,
  `@remotion/paths`, `@remotion/noise`, `@remotion/three`, `three` and
  `@react-three/fiber`. Pictures attached to the card are passed in as `props.images`.
- The video service (`video/`, the `video` container) is built once with internet: it
  downloads Remotion 4.0.487 and its Chrome, about 1 GB, so the first
  `docker compose up -d --build` takes a while. At runtime it's on a private network with
  no internet, sees none of your files or keys, runs as an ordinary user, and only the
  harness can reach it. The scene code runs only inside it. No internet means scenes use
  system fonts and draw their own graphics (no web fonts or remote images).
- There's no GPU in the container, so Remotion renders in software (`VIDEO_GL=swangle`,
  which also runs 3D). Expect roughly a few seconds of rendering per second of video for
  simple scenes; `VIDEO_CONCURRENCY` sets how many Chrome tabs render frames at once.
- Licence: Remotion is free for individuals and companies of up to 3 people; larger
  companies need a company licence (remotion.pro).
- The card's time limit is paused while rendering.

API: `POST /api/tasks/:id/video` renders the scene in a finished card's answer. The video
service itself: `POST /render`, `GET /jobs/:id`, `GET /jobs/:id/video`, `GET /health`.

## Home and the new look

The dashboard opens on **Home**: a greeting (click your name to set it), the **Jarvis**
orb (press the mic to say a task, press again to send; it's transcribed on your PC; or
type one and press Run), **System** (VRAM in use from Ollama against `GPU_VRAM_GB`, the
speed of the last answer, running and queued cards, loaded models), **Brain** (memories,
vault notes and when the vault last changed, which services are on), **Team** (each
agent's model and what it's doing), **Board** (counts, the running card with Open and
Cancel, what's up next), **Hive mind**, **Routines** and **Memory**.

Pages are on an icon rail down the left (Home, Console, Board, Routines, Skills, Assets,
Files, Team; Projects at the bottom). On a phone there's a tab bar instead: Home, Board,
a mic button, Console and a menu with every page. Home and the Board are laid out for
phones; the other pages are built for desktop and stack or scroll on a small screen.
The mic needs https or localhost (browsers block it on plain http addresses).

The whole dashboard is near-black with a red accent. The colours are set once in
`ui/src/index.css` (`@theme`): change the `slate` and `cyan` scales there to restyle
every page.

## Annotate (point at things in the browser)

In the Console's **Browser** tab, press **📌 Annotate** and click things on the live page:
each click pins the element under it (numbered, outlined, with a small picture). Add a
note to any pin ("click this", "use this price", "what does this mean?") and a message,
then:

- **Send to the agent** (while a card's agent is browsing): it reads your message and pins
  before its next step, and can act on exactly what you pointed at by using the pin as
  its target (`"target": "#1"`). Clicks and typing still go through approvals, and
  password, payment and ID fields are still refused.
- **Make a card**: a new browser card that starts on the same page with your pins
  described, and the same profile in a profile window (its sign-ins are saved first;
  the card takes the profile over, so your window closes when it starts).

Pins never read what's typed in fields. They're lost when the page changes (the agent is
told so). Esc or 📌 leaves Annotate. Clicks in the Browser tab (Annotate and Take over)
are now measured on the picture itself, so they land right however the panel is shaped.
(An idea from Agent Zero.)

API: `POST /api/browser/:id/inspect {x, y}` (page pixels, 1280×800),
`POST /api/browser/:id/annotate {message, pins: [{n, note}], mode: "agent" | "card"}`,
`POST /api/browser/:id/pins/clear`.

## Model presets

Saved team setups: which model (and fallback) each agent uses, switched in one go.

- **Built in:** **All local** (every agent on its default local model) and **Fast** (every
  agent on `OLLAMA_FAST_MODEL`; vision and audio keep models that can see and hear). Fast
  only appears when the fast model differs from the main one, so set
  `OLLAMA_FAST_MODEL=qwen3:4b` in `.env` to get it.
- **Your own:** set the agents up on the Team page (say, cloud models for Jarvis and the
  Coder), then **Save the current setup as a preset** ("Best quality"). **Update** stores
  the current setup in it again; Rename and Delete do what they say.
- **Switching:** the **Models** picker at the top of every page, **Apply** on the Team page,
  or type "use preset fast" (also "switch to the local preset") in a card or on Telegram.
  Local-only agents keep a local model when a preset would give them a cloud one; you're
  told which.
- **Per project:** pick a preset in a project's settings and its cards use those models,
  whatever the team is switched to (other cards are unaffected). A project kept on this
  PC still replaces cloud models with local ones.

API: `GET/POST /api/presets`, `PATCH/DELETE /api/presets/:id`, `POST /api/presets/:id/apply`;
`preset` on projects; `/api/system` reports the active preset.

## Workspaces and undo (time travel)

The Coder and File agents can now edit real files, and every change can be undone
(Agent Zero's "time travel" idea).

- **Workspaces.** Each project has a folder its agents may edit: `data/workspaces/<project>`
  by default (`general` for General), or a folder you name in the project's settings. To
  let them work on your own repos, mount the folder that holds them in
  `docker-compose.yml` (`- ~/code:/workspaces`), set `WORKSPACES_DIR: /workspaces`, and
  give the project the repo's folder name.
- **Per card.** Tick **Edit files in the workspace** on a card. The agent sees the file
  list and the contents of the files you name (or the whole workspace when it's small;
  `WORKSPACE_CONTEXT_CHARS`, 12,000 by default for an 8K context), and writes whole files
  in ```` ```file path=… ```` blocks (```` ```delete path=… ```` deletes). Mission Control
  writes them after the answer. Teammates' blocks count too when Jarvis delegates.
- **Never touched:** paths outside the workspace (no `..`, no absolute paths, no symlinks
  leading out), secret files (`.env`, keys, `.npmrc`, credentials, `.git/`), binary files,
  files over 256 KB. Read-only cards and routines never write.
- **Undo.** Each card's edits are one change set: see it on the card (**File changes**,
  with diffs) or on the **Files** page (the project's whole history, plus a file viewer).
  **Undo** puts the files back as they were. If a file changed since (a later card or
  your own edit), it asks first, and the overwritten version stays in the history.
  Undoing an undo redoes it. Notes the agents save to your vault (and routine notes)
  are recorded the same way, so they can be undone too.
- Contents are kept by hash in `data/blobs`; the last 5,000 change sets are kept.
- Workspace files go to the Coder's model like the rest of the request (secret files
  never do). For code that mustn't reach a cloud model, use a project kept on this PC.

API: `GET /api/changes?project=&task=`, `GET /api/changes/:id` (diffs and conflicts),
`POST /api/changes/:id/undo` (`{force: true}` past conflicts), `GET /api/workspace?project=`,
`GET /api/workspace/file?project=&path=`; `workspace` on cards, `changes` in card summaries.

## Projects

Separate workspaces on one Mission Control (an idea from Agent Zero, MIT). Pick the
project in the switcher at the top of the page; **Manage projects…** creates and edits them.

- **Instructions.** Each project has instructions every agent follows on its cards ("Gamface
  is a mobile gaming app; write in a playful voice; the repo is …"). A note in your vault at
  `HQ/projects/<project name>.md` is added too (private, like the other vault notes).
- **What stays inside a project:** memories (facts the memory model marks as being about the
  project; facts about you in general stay General), the activity log, skills, assets, its
  own brand (optional; otherwise the General one), browser sign-ins (profiles you assign to
  it) and routines. Anything in **General** is shared with every project.
- **Kept on this PC.** Tick it and every model call for that project uses a local model,
  whatever the agents' settings say (enforced in the gateway, like the local-only lock),
  and everything it learns stays in the project.
- **Sign-ins.** A project's profiles can't be used by other projects' cards or routines. If
  the default profile belongs to a project, other cards browse without sign-ins.
- **Moving and tidying.** Move a card from its detail view (not while it runs). Archive a
  project to hide it (its cards stay). Deleting needs an empty project (no cards, assets,
  skills or routines left); its memories and brand are deleted with it.
- The board, history search, Hive Mind, Memory, Skills, Routines and Assets show the chosen
  project (its own items plus General ones); **All projects** shows everything, with a
  coloured project tag on each card.

API: `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`; `project` on cards,
routines, skills, assets and memories; `?project=<id>|general` on `/api/hive`,
`/api/memories`, `/api/search` and `/api/assets`; `PUT/DELETE /api/brand?project=<id>`.

## Tools (MCP servers)

Agents can use outside tools: MCP servers such as the ones
[CLI Printing Press](https://github.com/mvanhorn/cli-printing-press) prints for an API or
website, or a search API. The **Tools** page (wrench icon) lists them, shows which are
read-only and which change things, and lets you try any read-only tool.

Installed:

| Server | Tools | Key |
|---|---|---|
| `wikipedia` | `search`, `article` (written for Mission Control) | none |
| `brave` | `web_search`, `news_search` through the Brave Search API, so agents can search without search-engine pages and their bot checks (written for Mission Control) | `BRAVE_API_KEY` in `tools/.env`: get a free key at api-dashboard.search.brave.com, then `docker compose up -d tools`. Without it the tools say how to set it up |
| `espn` | `today`, `scores`, `odds`, `trending`, `compare`, `transactions`, `boxscore`, `recap`, `news_list`, `teams_list`, `teams_get`, `teams_schedule` ([Printing Press library](https://github.com/mvanhorn/printing-press-library), built from a reviewed, pinned commit) | none |

ESPN's `standings`, `leaders`, `injuries`, `scoreboard_get` and `rankings_get` are left out:
their results are 0.2–2.4 MB and ignore `select`, so they always exceed the size limit.
The `demo` server is still there, switched off (`"enabled": false`).

- **Jarvis Tools** is the teammate that uses them. It sees the installed read-only tools
  (names, descriptions, parameters), calls one per step, reads the result and answers only
  from what the tools returned. The card shows every call (`🔧 demo.time {}` and its result).
  Loop guards: a failed call gets one retry, the same call right after it worked is skipped,
  a tool that doesn't exist is skipped, and three skips force an answer (`TOOLS_MAX_STEPS`,
  default 6). Its model is set on the Team page like the others.
- **Routing and handoffs.** The router and Jarvis learn what the installed tools do (checked
  again every 5 minutes); auto cards that a tool clearly answers go to Tools, and Jarvis can
  hand work over with `@tools: …`. With no tools installed, the Tools teammate isn't offered.
- **Private context asks first.** Jarvis always sees your hive log and memories, so before a
  handoff's tool calls go outside, Mission Control checks whether the handoff repeats anything
  from them that isn't public (your own request, the instructions and the tool list are public):
  names and other proper nouns, specific numbers and identifiers (3+ digits, emails, links,
  codes), and five-word phrases copied from your memories, vault notes or private skills. If it
  does, each call waits for your approval and says what it carries ("its instructions include
  Patel, 48213 from your private notes…"). If not, read-only calls just run and the card says
  so. A private skill attached to a Tools card also makes its calls ask. The check can't see a
  paraphrase in plain words ("a peanut allergy" from "allergic to peanuts"); set *Tool calls from
  private context* on the Team page to allow or block, as you prefer. The rule that a local lead's
  teammates stay on local models is unchanged.

- **The tools service** (`tools/`, the `tools` container) starts the servers listed in
  `tools/tools.json` and lets the harness list and call their tools. It has internet for
  the tools but sees none of your files and none of Mission Control's keys. Only the harness
  can reach it, and the harness refuses any request that comes from it, so a tool can't call
  back into Mission Control.
- **Adding a tool:** install its program in `tools/Dockerfile` with a fixed version, add it to
  `tools/tools.json`, put any API key it needs in `tools/.env` (named in that server's `env`),
  then `docker compose up -d --build tools`. Only the variables a server names reach it.
- **Read-only tools just run.** A tool counts as read-only when its server is marked
  `"readOnly": true`, when the tool says so itself (MCP `readOnlyHint`), or when
  `tools.<name>.readOnly` says so.
- **Tools that change things ask first.** Each call waits for your approval on the dashboard
  (or in Telegram) and shows exactly what would be sent ("use demo.add_note, which changes
  things, with {"text":"buy milk"}"). A declined call isn't made, and the agent says so in its
  answer. Set *Tools that change things* to allow or block in the Team page's approvals section.
  A tool that may delete or overwrite something (MCP `destructiveHint`, which counts as true
  unless the tool says `false`) is high risk: it always asks, and "approve for this card" doesn't
  cover it. The tools service only runs a change when the harness says it was approved.
- **Routines and read-only runs** never see tools that change things: nobody is there to
  approve a routine's call, and read-only means read-only. The card says what was left out.
- Tool output is treated like a web page: untrusted, and cleaned of private-context markers
  and secrets before anything sees it.
- **Per-server settings in `tools.json`:** `notes` (tips the agent sees with that server's
  tools, like ESPN's sport/league pairs), `only` (an allowlist of the server's tools),
  `tools.<name>.enabled` / `.readOnly`, `hideParams` (parameters the agents never see or set,
  like a CLI's `--no-color`), and `defaults` (sent on every call to tools that have them, like
  ESPN's `agent: true`), and `timeoutMs` (how long one call may take, up to 10 minutes; the
  images server uses this).
- After changing `tools/Dockerfile` or `tools/tools.json`, use `docker compose up -d --build tools`
  (or `--force-recreate`); a plain `restart` once left the harness unable to find the container.

API: `GET /api/tools` (servers and tools; `?fresh=1` skips the one-minute cache),
`POST /api/tools/call { server, tool, args }`. The tools service: `GET /tools`, `POST /call`,
`GET /health`.

### Pictures (images server, ComfyUI on your graphics card)

"Make a picture of…", "create a photo of…", "draw a logo…" go to the Tools agent, which calls
`images.generate_image`. The picture is saved as a file on the card (`data/files/*.png`) and shown
there; the agent only says what it made. Asking about a picture you attached still goes to Vision.
With no picture tool installed, Jarvis says plainly that it can't make pictures.

AI video clips (LTX-Video in ComfyUI) were tried and taken out on 19 Nov 2026: on this PC (31 GB
RAM, AMD card) a clip needs ~13–14 GB of free RAM because the AMD driver keeps much of the model
in "shared GPU memory", and running out of RAM stalled WSL and damaged its disk once. Videos are
made with Remotion only (see Videos). `%USERPROFILE%\.wslconfig` still caps WSL (and with it
Docker) at 9 GB plus 8 GB of swap, so ComfyUI keeps room for pictures.

- **What does the drawing:** ComfyUI from the Comfy Desktop install on Windows
  (`%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Installs\GAMFace`, AMD ROCm build) with Z-Image Turbo
  (`z_image_turbo_bf16.safetensors`, `qwen_3_4b.safetensors`, `ae.safetensors` in
  `ComfyUI-Shared\models`). It listens on 127.0.0.1:8188 only; containers reach it as
  `host.docker.internal:8188` through Docker Desktop.
- **Starts with Windows:** the scheduled task *Mission Control ComfyUI* runs 30 seconds after
  you log in. It runs a copy of `tools/comfyui/start-comfy.ps1` kept at
  `%LOCALAPPDATA%\Comfy-Desktop\start-comfy-hq.ps1` (WSL may not be up yet at login), so after
  editing the script here, copy it there again. Start it by hand with
  `Start-ScheduledTask "Mission Control ComfyUI"`; turn auto-start off with
  `Disable-ScheduledTask "Mission Control ComfyUI"`.
  It runs hidden; logs go to `%LOCALAPPDATA%\Comfy-Desktop\hq-logs`. Starting it twice is safe.
  Don't open the Comfy Desktop app at the same time (same port).
- **Speed:** about 95 seconds for a 1024×1024 picture on the RX 9060 XT (the first one after
  starting takes a little longer while the models load). Sizes: square, landscape, portrait,
  wide, small (768×768, faster).
- **Why it's slow (AMD bug):** with ROCm 7.14 / torch 2.12 on Windows, hipBLASLt crashes ComfyUI
  (access violation) on every float32 matrix multiply and on small attention, which every text
  encoder does. The start script switches it off (`ROCBLAS_USE_HIPBLASLT=0`,
  `TORCH_BLAS_PREFER_HIPBLASLT=0`); everything then works, about 10x slower. Retest after a
  Comfy Desktop update: start ComfyUI without those two settings and make one picture.
- If ComfyUI isn't running, the card says so and how to start it.

## Voiceovers, captions, assets and templates

Videos can now talk, show captions in sync, use your real logos, pictures, clips and
music, and follow your brand.

- **Voiceovers.** Ask for one ("…with a voiceover", "a narrated explainer") and the Coder
  writes the narration as well as the scene. The **voice service** speaks it with
  [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0, runs on the CPU), and
  the video becomes at least as long as the narration. Pick the default voice and speed
  on the **Assets** page (▶ plays a sample); a scene can choose another with `voice=` in
  its first line. Replies and fixes keep the same narration unless it's rewritten.
- **Captions.** Ask for captions or subtitles and they appear word by word, in sync,
  because [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT) listens to the
  voiceover and times every word. Captions show the narration's own spelling. Styles:
  karaoke (default), pop or block, set on the Assets page.
- **Your own recording.** Attach a recording and say "use my recording" (or "caption my
  recording"): it becomes the soundtrack, the video lasts as long as it does, and its
  words are timed for captions.
- **Asset dictionary** (**Assets** tab). Upload logos, pictures, B-roll clips, music,
  sound effects and fonts, and describe each one. When you ask for a video, the assets
  whose name, description or tags share words with your request go to the Coder, which
  uses them by id instead of inventing visuals. Music is only added when you ask for
  music; it plays under the whole video (quieter under a voiceover), and its beats are
  found automatically so visuals can hit them. Files are checked by their bytes; limits:
  pictures 10 MB, audio 30 MB, clips 80 MB, fonts 5 MB, 300 assets.
- **Brand.** Name, tagline, five colours, font (a system font or one you uploaded), logo,
  voice and caption style. The templates and pieces use them automatically.
- **Templates.** Every scene can import Mission Control's kit (`video/mc.tsx`): ready-made
  templates the Coder only fills in, which makes videos far more reliable from local
  models: `Promo` (title, points, call to action), `Explainer` (numbered steps), `Social`
  (vertical shorts with big captions) and `Quote`. Plus pieces for custom scenes:
  `TitleCard`, `KineticText`, `BulletList`, `LowerThird`, `Media`, `Logo`, `EndCard`,
  `Background`, `Captions`, `Section`, and `useBeat()`, `cueFrame()` to time visuals to
  the beat or to a spoken word. Ask for "vertical", "reel" or "TikTok" for 1080×1920.
- The voice service (`voice/`, the `voice` container) is built once with internet: it
  downloads Kokoro (about 330 MB) and the Whisper model (`VOICE_WHISPER_MODEL`, default
  `base.en`; `small.en` times words more accurately but is slower). At runtime it's on the
  same private network as the video service: no internet, none of your files. Speaking
  takes about a second per sentence on the CPU.

API: `GET/POST /api/assets`, `PATCH/DELETE /api/assets/:id`, `GET /api/assets/:id/file`,
`POST /api/assets/:id/beats`, `PUT /api/brand`, `POST /api/voice/preview`. The voice
service: `POST /speak`, `POST /words`, `POST /beats`, `GET /health`.

## Skills and history search (Phase 6)

**Skills** are reusable procedures the agents follow when a request fits (an idea from
Hermes Agent). They're learned from your own finished work, and nothing is used until you
approve it.
- After a complex card (Jarvis delegated, the browser took 4+ steps, or you replied to
  it), your local **Memory** model drafts a skill from it when nothing else is running:
  a name, when to use it, which agents use it, and general numbered steps. You can also
  press **✨ Make a skill** on any finished card. A notice tells you a draft is waiting.
- **Skills** page: edit a draft and **Approve** it, or **Discard** it. A draft named like
  an existing skill is shown as an update and merges into it. Switch skills on and off,
  edit or delete them, or add your own (those are on straight away). Turn off automatic
  drafts there too.
- When a request shares at least two words with an active skill's name or description,
  and the skill is for that agent, it's added to the agent's instructions for that
  request (at most two). The output says "[Using skill: …]". Teammates Jarvis delegates
  to get their matching skills too.
- Skills drafted from private material (vault notes, memories, attachments) are marked 🔒
  and withheld from cloud models. Read-only runs, routines, voice and evals never draft
  skills.

**History search:** the box on the Board searches every card's request, replies and
answer, removed (archived) cards included. Words match as prefixes; put "an exact
phrase" in quotes. Click a result to open the card; archived cards have **Put back on
the board**. Cards from before this update are indexed on first start.

API: `GET/POST /api/skills`, `PATCH/DELETE /api/skills/:id`, `POST /api/skills/:id/approve`,
`PUT /api/skills/settings` (`{ auto }`), `POST /api/tasks/:id/skill`, `GET /api/search?q=`,
`POST /api/tasks/:id/restore`.

## Browser profiles and taking over (Phase 5)

Each **browser profile** is a separate set of sign-ins ("main", "shopping", "work"…). Its
cookies are loaded into a fresh, isolated browser context when a run starts and saved
back when it ends, so a login survives restarts of Chrome and Mission Control.
- **Browser tab → Profiles:** add a profile, make one the default, delete one, or
  **Open** it to sign in to sites yourself (type a page address first). You're at the
  controls: click the screen, type, scroll, use the address bar, then **Close & save**.
- **Cards** browse with the default profile, or pick one ("Browse signed in as") in the
  new-card form. **Routines** that may act can pick one too. Read-only runs never use a
  profile: they always get a throwaway one.
- **Take over:** while an agent is browsing, **Take over** pauses it after its current
  step. You can click, type, scroll and go to addresses; nothing you do asks for
  approval. **Hand back** and the agent looks at the page again and carries on. The
  card's time limit is paused meanwhile, and the browser comes back to the agent by
  itself after `TAKEOVER_TIMEOUT_MIN` (30) minutes.
- **The agent can ask for you:** when a page needs a sign-in, a code or a check, the
  agent hands off ("Please sign in to …"). The request shows in the bar at the top of
  every page (and in Telegram) with **Go to the browser**.
- Agents still never type passwords or payment details themselves (Phase 4): that's what
  taking over is for.
- Sign-ins are saved in `data/profiles/`, readable by you only. Set `PROFILE_SECRET` to
  encrypt them (AES-256-GCM); keep it, because profiles saved with it can't be read
  without it.

API: `GET/POST /api/profiles`, `PUT /api/profiles/default`, `DELETE /api/profiles/:name`,
`POST /api/profiles/:name/open` (`{ url? }`), `GET /api/browser/sessions`,
`POST /api/browser/:id/takeover`, `/handback`, `/close` (profile windows) and `/input`
(`{ type: "click", x, y }`, `{ type: "type", text }`, `{ type: "key", key }`,
`{ type: "scroll", dy }`, `{ type: "navigate", url }`, `{ type: "back" }`).

## Approvals (Phase 4)

Agents now ask before they change anything on a web page. When the browser agent wants to
type into a field, submit a form or click a button, the card pauses (⏸ on the board) and a
bar appears at the top of every page: what it wants to do, a screenshot with the target
outlined, and **Approve**, **Approve for this card on this site** or **Deny** (with an
optional note the agent sees). Telegram gets the same request with buttons, and
`/approvals`, `/approve <code>` and `/deny <code>` work there too.
- Plain links are opened directly, like typing their address, so they never ask.
- No answer within 15 minutes (Team page → Approvals) counts as "no". The card's own
  time limit is paused while it waits.
- Team page → **Approvals**: Ask / Allow / Block for typing, submitting, clicking and
  searching (searching a site is allowed by default), and a record of every answer.
- Rules no setting changes:
  - Password, payment, bank, ID-number and one-time-code fields are never typed in, even
    if you approve. The agent tells you to enter those yourself.
  - Buy, pay, order, transfer, subscribe and delete-style buttons are marked HIGH RISK
    and always ask; "this card on this site" doesn't cover them.
  - Routines that may act always ask, even for actions set to Allow.
- Read-only runs never act at all.
- Vault notes no longer overwrite each other: a second note with the same name gets (2).

API: `GET /api/approvals` (pending, recent answers, settings), `POST /api/approvals/:id`
(`{ approve, scope?: "once" | "card", note? }`), `GET /api/approvals/:id/screenshot`,
`PUT /api/approvals/policy`.

## Routines (scheduled runs)

The **Routines** page runs requests on a schedule. Each run is a card on the board (⏱),
read-only unless the routine has **May act** turned on, and its result goes to one place:
the dashboard, Telegram, or a note in the vault's `HQ/routines` folder. A routine that may
act can type, submit and click on its own sites only, and every such action waits for
your approval (see Approvals).
- Schedules in plain words or cron: `weekdays at 7:30am`, `every 2 hours`, `hourly`,
  `every hour at :30`, `daily at 6pm`, `mondays at 9am`, `mon, wed and fri at 6pm`,
  `weekends at noon`, `monthly on the 1st at 9:00`, or five cron fields
  (`30 7 * * 1-5`). The form shows the next three times as you type.
- Times are in your browser's time zone (saved with the routine), and daylight saving is
  handled: a time that doesn't exist that day is skipped, and a repeated hour runs once.
  The server's default is `ROUTINE_TZ` (or the system's time zone).
- Guards: a routine never overlaps itself (if its last card is still queued or running,
  the run is skipped and the page says why); runs are at least `ROUTINE_MIN_MINUTES`
  apart (default 5); at most 50 routines. Runs missed while Mission Control was off or the
  PC was asleep are skipped, with a dashboard notice, unless the routine has
  **Catch up on a missed run**, which runs it once (not once per missed time).
- Read-only means the browser can open pages, scroll, go back and follow links, only on
  the routine's sites (or sites named in its request), and never types or submits.
  Routine runs never save notes or memories, whether they may act or not. Its findings stay on its card; the shared activity log only notes
  that it ran.
- **Run now** starts a run at once; **Show runs** lists recent runs with their results and
  any PDFs. Turning a routine off keeps it and its history.

API: `GET /api/routines`, `POST /api/routines` (`{ name, prompt, schedule, timezone?,
targetAgent?, deliverTo?, allowedSites?, enabled?, catchUp? }`), `PATCH /api/routines/:id`,
`DELETE /api/routines/:id`, `POST /api/routines/:id/run`, `GET /api/routines/:id/runs`,
`POST /api/routines/preview` (`{ schedule, timezone }` → label and next three times).

## Pictures

Attach pictures (PNG, JPEG, GIF, WebP, up to 10 MB, 6 per card) to a new card or the
Console box: pick them, drag them in, or paste a screenshot straight into the text box.
- A card with pictures and **Auto-route** goes to the **Vision** agent.
- If you pick another agent, Vision reads the pictures first and that agent gets its
  description. When Jarvis delegates to `@vision`, the pictures go along.
- Pictures are private, like your notes: they never go to a cloud model unless you tick
  *Private → cloud* for the Vision agent, and answers about them are marked 🔒.
- The Vision agent needs a model that can see. It defaults to `ollama/qwen3.5:latest`
  (set `OLLAMA_VISION_MODEL` to change it); `gemma4:12b` also fits a 16 GB card. A model
  that can't read pictures is refused with a message saying so.
- Pictures are stored in `data/uploads/`, named by their content hash.

API: `POST /api/uploads` with `{ "data": "<base64 or data: URL>" }` returns `{ id }`; pass
ids in a card's `images`. `GET /api/uploads/:id` returns the picture.

## Reading PDFs

Attach PDFs to a new card, the Console or a reply: pick or drop them (📑, up to 4 per card,
25 MB each). Leave the task box empty and it becomes "Summarize the attached PDF."
- The harness pulls the text out on your PC with pdf.js (run `npm install` once after
  pulling; it's a new dependency). Nothing in the file runs, fonts aren't loaded and
  nothing is fetched. Broken or password-protected files are refused at upload.
- Short PDFs go to the agent whole, with page markers. Long ones are read in parts by
  **Jarvis File** (its model, local only by default): each part gets notes on what helps
  with your request, with page numbers, and the agent answers from those notes. The
  output shows each part as it's read. At most 10 parts are read (`MAX_DOC_PARTS`), so
  very long documents may have their last pages skipped; the output says which.
  How much counts as short depends on `OLLAMA_NUM_CTX` (about 2.4 characters per token
  of context).
- Scanned PDFs have no text to read: they're flagged "⚠ scanned?". Attach screenshots of
  their pages as pictures and Vision reads them.
- PDF contents are private, like pictures and audio: they never go to a cloud model
  unless you allow it, and answers that used them are marked 🔒.
- Auto-routing now sends questions about attached PDFs and notes to File or Jarvis.

API: `POST /api/uploads` with `{ "data": "<base64 PDF>", "kind": "pdf", "name": "x.pdf" }`
returns `{ id, name, pages, scanned }`; pass ids in a card's `documents`.
`GET /api/uploads/:id/info` returns the name and page count.

## PDF reports

Ask for a PDF ("…as a PDF", "give me a report in pdf") and the agent writes the document
itself in Markdown; when it finishes, Mission Control prints it to a styled A4 PDF (title
header, sections, tables, pictures with captions, page numbers). The PDF appears on the
card (📄 on the board, open or ⬇ download in the drawer and Console). Any finished card
can also be turned into a PDF with **📄 Save as PDF**.
- Pictures: the agent may use your attached pictures, or image URLs it actually saw on a
  web page (the browser agent now sees each page's large pictures). Mission Control
  downloads each one with the browser's address checks (no private-network addresses
  unless `BROWSER_ALLOW_PRIVATE=true`), keeps only real PNG/JPEG/GIF/WebP files up to 8 MB,
  and embeds them. Links that don't lead to a real picture are left out, and the
  output says how many were skipped.
- Printing uses the browser sidecar (`BROWSER_CDP_URL`) in a throwaway profile with
  scripts off and every network request blocked, so a report can't load or run anything.
  Only headless Chrome can print, so point `BROWSER_CDP_URL` at the sidecar.
- Files are saved in `data/files/`.
- "File" is for your own notes; requests to write a document or PDF now route to Jarvis
  (or the browser agent when it needs the web).

API: `POST /api/tasks/:id/pdf` makes a PDF from a finished card's answer and returns
`{ name, url }`; `GET /api/files/:name` serves it (`?download=1` to download).

## Replying to cards

When a card finishes (Done, Review or Failed), a **Reply** box sits under its output, in the
card drawer and in the Console. Type an answer (Ctrl+Enter), optionally attach pictures or
audio, and the card runs again with the conversation so far:
- The agent gets the earlier turns as chat history (the last 12, up to 4,000 characters
  each) and your reply as the new message. The output keeps growing under
  `── You replied ──` headers, and cards show 💬 with the number of replies.
- **To** picks who answers: the same agent (default), Auto-route, or any agent. The browser
  agent also gets the original request, since it works from one instruction.
- Earlier answers that used private material (vault notes, memories, pictures, audio
  transcripts) stay private: if the reply runs on a cloud model, those turns are withheld,
  and your own words still go.
- You can't reply while a card is running; cancel it first. **Run again** re-runs the
  latest round.

API: `POST /api/tasks/:id/reply` with `{ "message": "…", "images": [], "audio": [],
"targetAgent": "same" }`. `GET /api/tasks/:id` returns the conversation as `thread`.

## Audio

Attach audio to a new card or the Console box: pick or drop a file (MP3, M4A, WAV, OGG,
WebM, FLAC: anything your browser can play), or press **🎙 Record** to use the microphone.
Up to 4 clips per card, 25 MB each after conversion (about 13 minutes).
- The dashboard converts every clip to 16 kHz mono WAV in the browser, so the PC needs
  no ffmpeg.
- Before routing, the **Transcriber** turns each clip into text. Long recordings are split
  into 28-second pieces, because Gemma 4 takes at most 30 s at a time. The transcript
  shows in the output and goes to the agent with your request (and to the router, so
  "summarise this voice memo" routes on what was said). You can leave the task box empty:
  it becomes "Listen to the attached audio and respond."
- **Whisper first.** Recordings (the Home mic and attached audio) are turned into text by
  the voice service's faster-whisper on the CPU, the same way the "Hey Jarvis" wake word
  does it, so the GPU stays free for the agents. If Whisper isn't available or fails, the
  Transcriber below is used instead. Set `TRANSCRIBE_WITH=model` to always use the Transcriber.
- The Transcriber defaults to `ollama/gemma4:12b` (set `OLLAMA_AUDIO_MODEL` to change it)
  and is **local only** out of the box. You can also point it at a local Whisper server
  (any OpenAI-style `/v1/audio/transcriptions`, such as faster-whisper-server) by adding it
  as a provider on the Team page.
- Audio and transcripts are private, like pictures: they never go to a cloud model unless
  you unlock the Transcriber and tick *Private → cloud*, and never while a spend cap is set
  (audio cost can't be counted in tokens). Answers that used them are marked 🔒.
- Clips are stored in `data/uploads/` as `.wav`, named by their content hash, and play
  back from the card.

API: `POST /api/uploads` with `{ "data": "<base64 WAV>", "kind": "audio" }` returns
`{ id, seconds }`; pass ids in a card's `audio`.

Browser safety:
- Every request the page makes (navigations, redirects, images, scripts) is checked; anything aimed at localhost, `*.local` or your private network (10.x, 172.16–31.x, 192.168.x, Tailscale 100.64.x) is blocked, so a web page can't steer the agent into your router, Proxmox or the harness.
- Page text is passed to the model as untrusted data, and the agent is told never to sign in, enter passwords, payment or personal details, buy or post.
- Chrome runs in its own container with no port published to your PC, at most `BROWSER_MAX_STEPS` actions per task (default 10).
- If Chrome isn't running, the browser agent says so and answers without it.

Behaviour kept on purpose:
- **Evals** (`source: "eval"`) get the bare prompts: no team context, no delegation, no real browsing, and they stay out of the hive, so scores stay comparable with your earlier results.
- **Voice** tasks get team context and memory but never delegate, so Jarvis still gives one short spoken answer.
- API clients that send no `targetAgent` still default to `planner`. Only the dashboard defaults to `auto`.

## Install / update

The code lives in GitHub (`Gamface/GAMFace-HQ`, folder `mission-control`). In WSL:

```bash
cd ~/sandcastle/ts-harness
git status                      # commit or stash any local edits first
git remote -v                   # does it point at GAMFace-HQ?
```

If it does, `git pull`. If not, update it from a clone (your `.env` and `data/` stay as
they are):

```bash
git clone https://github.com/Gamface/GAMFace-HQ.git ~/GAMFace-HQ 2>/dev/null || git -C ~/GAMFace-HQ pull
rsync -a --exclude .env --exclude data --exclude node_modules --exclude .git \
  ~/GAMFace-HQ/mission-control/ ~/sandcastle/ts-harness/
```

Then restart. The containers run `npm install` themselves, so new packages (pdf.js)
arrive on their own:

```bash
cd ~/sandcastle/ts-harness
docker compose pull browser               # newer headless Chrome
docker compose up -d --build --force-recreate   # --build: the video and voice services (first time ~2 GB)
docker compose exec harness npm test      # optional: about 135 tests
docker compose exec voice python -m unittest test_timing   # optional: the voice service's timing
```

Without Docker: `npm install`, then `npm start` (and `npm install && npx vite` in `ui/`).

`.env` settings worth adding (all optional; see `.env.example`): `PROFILE_SECRET` before
you save any sign-ins, `ROUTINE_TZ=America/New_York`, `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_ALLOWED_CHAT_IDS` (approvals and hand-offs on your phone), `OBSIDIAN_VAULT` with
the vault line in `docker-compose.yml`.

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
npm test        # HQ unit tests (30), no Ollama needed
npm run eval    # your existing eval suite, unchanged
```
