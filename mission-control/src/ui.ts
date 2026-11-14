import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import {
  AgentStatus,
  AgentStreamPayload,
  AgentTarget,
  AgentTaskSchema,
  TaskSummary,
  TERMINAL_STATUSES,
} from "./schemas/agent";
import { StreamGuard, redact } from "./hq/guard";
import { Hive } from "./hq/hive";
import { Memory } from "./hq/memory";
import { ChatMessage, makeJsonChat } from "./hq/ollama";
import {
  AGENT_KEYS,
  DELEGATION_RULES,
  NOTE_RULES,
  TEAM,
  parseDelegations,
  routeTask,
  saveNotes,
  synthesisPrompt,
  teamContext,
  vaultNotes,
  withLiveContext,
} from "./hq/team";
import { TelegramBot } from "./hq/telegram";

// --- Config (env vars, see .env.example) ------------------------------------
const PORT = Number(process.env.PORT) || 3008;
// Localhost only unless told otherwise; the compose file sets 0.0.0.0 inside the container
const HOST = process.env.HOST || "127.0.0.1";
// Native Windows Ollama on the RX 9060 XT (port 11435, see setup-ollama.ps1)
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11435").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:14b";
// Small model for routing and memory extraction; falls back to OLLAMA_MODEL
const OLLAMA_FAST_MODEL = process.env.OLLAMA_FAST_MODEL || OLLAMA_MODEL;
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";
const OLLAMA_THINK = process.env.OLLAMA_THINK === "true";
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS) || 10 * 60 * 1000;
const MAX_QUEUE = Number(process.env.MAX_QUEUE) || 20;
const MAX_TASK_HISTORY = Number(process.env.MAX_TASK_HISTORY) || 50;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
// Optional bearer token for the endpoints that start or stop work
const HARNESS_TOKEN = process.env.HARNESS_TOKEN || "";
// HQ features (see README-HQ.md)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || "";
const MEMORY_INTERVAL_MIN = Number(process.env.MEMORY_INTERVAL_MIN) || 30;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

// Voice answers are read aloud by ~/sandcastle/src/agent_engine.py
// (evals: voice-math, voice-explain)
const VOICE_STYLE =
  "This request was spoken and your answer will be read aloud, so these rules override any formatting instructions above: " +
  "give the direct answer in your first sentence, then at most two short sentences of context. " +
  "Use plain sentences only, with no markdown, numbered steps, lists or headings. " +
  "Do not write code unless the user explicitly asks for code; if they do, put it in one fenced block after a one-sentence summary.";

const hive = new Hive(DATA_DIR);

// --- Task state -------------------------------------------------------------
interface Task extends TaskSummary {
  events: AgentStreamPayload[];
  controller?: AbortController;
  abortReason?: "user" | "timeout";
  requestedAgent: string;
  activeAgent?: AgentTarget;
  chatId?: string;
  answer?: string;
}

const tasks = new Map<string, Task>();
const queue: string[] = [];
let runningTaskId: string | null = null;
// Memory extraction runs between tasks so it never competes with one for the GPU
const memoryJobs: { agent: AgentTarget; prompt: string; answer: string }[] = [];
let backgroundBusy = false;
// Seeded from the clock so ids keep increasing across restarts and a
// reconnecting UI never mistakes new events for ones it already has
let nextEventId = Date.now();

const app = express();
app.use(cors({ origin: CORS_ORIGINS }));
app.use(express.json({ limit: "1mb" }));

function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!HARNESS_TOKEN || req.headers.authorization === `Bearer ${HARNESS_TOKEN}`) return next();
  res.status(401).json({ error: "Missing or invalid bearer token" });
}

function summarize(task: Task): TaskSummary {
  const { events, controller, abortReason, requestedAgent, activeAgent, chatId, answer, ...summary } = task;
  return summary;
}

function agentLabel(task: Task) {
  return `Jarvis (${task.activeAgent ?? task.targetAgent})`;
}

// --- SSE --------------------------------------------------------------------
interface SseClient {
  res: Response;
  taskId?: string;
}
const sseClients = new Set<SseClient>();

function writeEvent(res: Response, payload: AgentStreamPayload) {
  res.write(`id: ${payload.eventId}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function emit(task: Task, status: AgentStatus, logChunk = "") {
  task.status = status;
  const payload: AgentStreamPayload = {
    eventId: nextEventId++,
    taskId: task.id,
    timestamp: Date.now(),
    status,
    activeSubAgent: agentLabel(task),
    logChunk,
    source: task.source,
  };
  task.events.push(payload);
  for (const client of sseClients) {
    if (!client.taskId || client.taskId === task.id) writeEvent(client.res, payload);
  }
}

function handleStream(req: Request, res: Response) {
  const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  // Browsers resend Last-Event-ID on reconnect, so replay anything missed.
  // ?replay=all on the first connect sends the full in-memory history.
  const header = req.headers["last-event-id"];
  const lastId = header ? Number(header) : req.query.replay === "all" ? 0 : NaN;
  if (Number.isFinite(lastId)) {
    const missed = [...tasks.values()]
      .filter((t) => !taskId || t.id === taskId)
      .flatMap((t) => t.events)
      .filter((e) => e.eventId > lastId)
      .sort((a, b) => a.eventId - b.eventId);
    missed.forEach((e) => writeEvent(res, e));
  }

  const client: SseClient = { res, taskId };
  sseClients.add(client);
  req.on("close", () => sseClients.delete(client));
}

// Comment frames keep proxies and the browser from timing out idle streams
setInterval(() => {
  for (const client of sseClients) client.res.write(": ping\n\n");
}, 15000);

// --- Ollama -----------------------------------------------------------------
const thinkingSupport = new Map<string, boolean>();

async function modelSupportsThinking(model: string): Promise<boolean> {
  if (thinkingSupport.has(model)) return thinkingSupport.get(model)!;
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const info = (await res.json()) as { capabilities?: string[] };
    const supported = Boolean(info.capabilities?.includes("thinking"));
    thinkingSupport.set(model, supported);
    return supported;
  } catch {
    return false;
  }
}

const jsonChat = makeJsonChat(OLLAMA_BASE_URL, OLLAMA_KEEP_ALIVE, 120000, modelSupportsThinking);
const memory = new Memory(DATA_DIR, jsonChat, OLLAMA_FAST_MODEL);

/**
 * Streams one model call into the task's output (through the exfiltration
 * guard) and returns the full raw text so the caller can look for handoffs.
 */
async function streamChat(task: Task, messages: ChatMessage[], signal: AbortSignal, push: (text: string) => void) {
  const body: Record<string, unknown> = {
    model: task.model,
    messages,
    stream: true,
    keep_alive: OLLAMA_KEEP_ALIVE,
    options: { num_ctx: OLLAMA_NUM_CTX },
  };
  // Only send "think" to models that support it; others reject the field
  if (await modelSupportsThinking(task.model)) body.think = OLLAMA_THINK;

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
  }

  const guard = new StreamGuard();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { message?: { content?: string }; error?: string };
        if (parsed.error) throw new Error(parsed.error);
        const content = parsed.message?.content ?? "";
        full += content;
        push(guard.push(content));
      }
    }
  } finally {
    push(guard.end());
    if (guard.found.size) {
      hive.log("guard", "redacted", [...guard.found].join(", "), task.id);
    }
  }
  return full;
}

// The system prompt only holds text that stays the same between calls, so
// Ollama can reuse its cached work for it; see teamContext in hq/team.ts.
function systemPrompt(task: Task, agent: AgentTarget, opts: { team: boolean; delegate: boolean }) {
  let system = TEAM[agent].prompt;
  if (task.source === "voice") system += ` ${VOICE_STYLE}`;
  if (opts.delegate) system += DELEGATION_RULES;
  if (agent === "file" && OBSIDIAN_VAULT && task.source !== "voice") system += NOTE_RULES;
  if (opts.team) system += teamContext(agent, vaultNotes(OBSIDIAN_VAULT, agent));
  return system;
}

// The parts that change on every call ride along with the request
function userMessage(agent: AgentTarget, text: string, recallFor: string, team: boolean) {
  if (!team) return text;
  return withLiveContext(text, { hive: hive.promptText(), memories: memory.recall(recallFor, agent) });
}

async function runTask(task: Task) {
  const controller = new AbortController();
  task.controller = controller;
  task.startedAt = Date.now();
  const timeout = setTimeout(() => {
    task.abortReason = "timeout";
    controller.abort();
  }, TASK_TIMEOUT_MS);

  // Batch tokens so the UI gets ~10 frames per second instead of one per token
  let pending = "";
  const flush = () => {
    if (pending) {
      emit(task, "streaming", pending);
      pending = "";
    }
  };
  const push = (text: string) => {
    pending += text;
  };
  const flushTimer = setInterval(flush, 100);

  // Evals measure the bare prompts, so they skip team context and delegation.
  // Voice answers are read aloud, so they don't fan out to teammates.
  const useTeam = task.source !== "eval";
  const canDelegate = useTeam && task.source !== "voice";
  // Eval runs stay out of the hive so they don't show up in other agents' context
  const log = (agent: string, event: string, summary: string) => {
    if (useTeam) hive.log(agent, event, summary, task.id);
  };

  try {
    if (task.requestedAgent === "auto") {
      emit(task, "routing");
      const routed = await routeTask(jsonChat, OLLAMA_FAST_MODEL, task.prompt);
      task.targetAgent = routed.agent;
      task.routedBy = routed.reason === "keyword match" ? "keywords" : "router";
      log("router", "routed", `→ ${routed.agent} (${routed.reason}): ${task.prompt}`);
    } else {
      log(task.targetAgent, "assigned", task.prompt);
    }

    const lead = task.targetAgent;
    const delegate = canDelegate && lead === "planner";
    emit(task, "thinking");
    const first = await streamChat(
      task,
      [
        { role: "system", content: systemPrompt(task, lead, { team: useTeam, delegate }) },
        { role: "user", content: userMessage(lead, task.prompt, task.prompt, useTeam) },
      ],
      controller.signal,
      push,
    );

    const handoffs = delegate ? parseDelegations(first) : [];
    let answer = first;
    if (handoffs.length) {
      task.delegatedTo = [];
      const results: { agent: AgentTarget; task: string; output: string }[] = [];
      for (const h of handoffs) {
        flush();
        task.activeAgent = h.agent;
        task.delegatedTo.push(h.agent);
        log("planner", "delegated", `→ ${h.agent}: ${h.task}`);
        emit(task, "delegating", `\n\n── ${TEAM[h.agent].name} ── ${h.task}\n\n`);
        emit(task, "thinking");
        const output = await streamChat(
          task,
          [
            { role: "system", content: systemPrompt(task, h.agent, { team: true, delegate: false }) },
            { role: "user", content: userMessage(h.agent, h.task, h.task, true) },
          ],
          controller.signal,
          push,
        );
        results.push({ agent: h.agent, task: h.task, output });
        log(h.agent, "finished", output);
      }
      flush();
      task.activeAgent = lead;
      emit(task, "thinking", `\n\n── ${TEAM[lead].name}: final answer ──\n\n`);
      answer = await streamChat(
        task,
        [
          { role: "system", content: systemPrompt(task, lead, { team: true, delegate: false }) },
          { role: "user", content: userMessage(lead, synthesisPrompt(task.prompt, results), task.prompt, true) },
        ],
        controller.signal,
        push,
      );
    }

    const notes = saveNotes(OBSIDIAN_VAULT, redact(answer).text);
    if (notes.length) push(`\n\n(Saved to vault: ${notes.map((n) => path.basename(n)).join(", ")})`);
    flush();
    task.answer = redact(answer.replace(/<note title="[^"]*">[\s\S]*?<\/note>/g, "")).text.trim();
    log(lead, "complete", task.answer);
    if (useTeam && task.answer) memoryJobs.push({ agent: lead, prompt: task.prompt, answer: task.answer });
    emit(task, "complete");
  } catch (error: unknown) {
    flush();
    if (controller.signal.aborted) {
      if (task.abortReason === "timeout") {
        task.error = `Timed out after ${Math.round(TASK_TIMEOUT_MS / 1000)}s`;
        emit(task, "error", `\n\n[${task.error}]`);
      } else {
        emit(task, "canceled", "\n\n[Generation stopped]");
      }
    } else {
      task.error = error instanceof Error ? error.message : String(error);
      console.error(`Task ${task.id} failed:`, task.error);
      emit(task, "error", `\n\n[Error: ${task.error}]`);
    }
    log(task.activeAgent ?? task.targetAgent, task.status, task.error ?? "canceled");
  } finally {
    clearTimeout(timeout);
    clearInterval(flushTimer);
    task.finishedAt = Date.now();
    task.controller = undefined;
    task.activeAgent = undefined;
    notifyDone(task);
  }
}

// One task at a time: two agents sharing one GPU each run at half speed
async function pump() {
  if (runningTaskId || backgroundBusy) return;
  const nextId = queue.shift();
  if (!nextId) return runBackgroundJob();
  const task = tasks.get(nextId);
  if (!task) return pump();
  runningTaskId = task.id;
  try {
    await runTask(task);
  } finally {
    runningTaskId = null;
    pruneHistory();
    void pump();
  }
}

// Memory extraction only runs when no task is waiting
async function runBackgroundJob() {
  const job = memoryJobs.shift();
  if (!job) return;
  backgroundBusy = true;
  try {
    const saved = await memory.extract(job.agent, job.prompt, job.answer);
    if (saved.length) hive.log("memory", "saved", saved.join("; "));
  } catch (error) {
    hive.log("memory", "error", error instanceof Error ? error.message : String(error));
  } finally {
    backgroundBusy = false;
    void pump();
  }
}

setInterval(() => {
  const stats = memory.maintain();
  if (stats.decayed || stats.forgotten || stats.merged) hive.log("memory", "maintenance", JSON.stringify(stats));
}, MEMORY_INTERVAL_MIN * 60 * 1000);

function pruneHistory() {
  const finished = [...tasks.values()]
    .filter((t) => TERMINAL_STATUSES.includes(t.status))
    .sort((a, b) => a.createdAt - b.createdAt);
  while (tasks.size > MAX_TASK_HISTORY && finished.length) {
    tasks.delete(finished.shift()!.id);
  }
}

function createTask(input: unknown, extra: { chatId?: string } = {}): { task?: Task; status: number; error?: unknown } {
  const parsed = AgentTaskSchema.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.flatten() };
  if (queue.length >= MAX_QUEUE) return { status: 429, error: `Queue is full (${MAX_QUEUE} tasks)` };
  const id = parsed.data.id ?? crypto.randomUUID();
  if (tasks.has(id)) return { status: 409, error: "A task with this id already exists" };
  const requested = parsed.data.targetAgent;
  const task: Task = {
    id,
    prompt: parsed.data.prompt,
    // Until the router runs, an "auto" task is shown as the planner's
    targetAgent: requested === "auto" ? "planner" : requested,
    requestedAgent: requested,
    routedBy: requested === "auto" ? undefined : "user",
    source: parsed.data.source,
    model: parsed.data.model ?? OLLAMA_MODEL,
    status: "queued",
    createdAt: Date.now(),
    events: [],
    chatId: extra.chatId,
  };
  tasks.set(id, task);
  queue.push(id);
  emit(task, "queued", `> ${task.prompt}\n\n`);
  void pump();
  return { task, status: 202 };
}

function enqueue(input: unknown, res: Response) {
  const result = createTask(input);
  if (!result.task) return res.status(result.status).json({ error: result.error });
  // position 0 means it starts right away
  const position = runningTaskId === result.task.id ? 0 : queue.indexOf(result.task.id) + 1;
  res.status(202).json({ taskId: result.task.id, position });
}

function cancel(taskId: string | undefined, res: Response) {
  const task = taskId ? tasks.get(taskId) : undefined;
  if (!task || TERMINAL_STATUSES.includes(task.status)) {
    return res.status(404).json({ error: "Task not found or already finished" });
  }
  const queuedAt = queue.indexOf(task.id);
  if (queuedAt >= 0) {
    queue.splice(queuedAt, 1);
    task.finishedAt = Date.now();
    emit(task, "canceled", "[Removed from queue]");
    notifyDone(task);
  } else {
    task.abortReason = "user";
    task.controller?.abort();
  }
  res.status(200).json({ status: "canceled", taskId: task.id });
}

// --- Telegram ---------------------------------------------------------------
let telegram: TelegramBot | null = null;

function notifyDone(task: Task) {
  if (!telegram || task.source !== "telegram" || !task.chatId) return;
  const text =
    task.status === "complete"
      ? task.answer || "(no answer)"
      : task.status === "error"
        ? `Task failed: ${task.error}`
        : "Task canceled.";
  telegram.send(task.chatId, text).catch((e) => hive.log("telegram", "error", String(e)));
}

if (TELEGRAM_BOT_TOKEN) {
  telegram = new TelegramBot(TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED, {
    submit: (prompt, agent, chatId) => {
      const result = createTask({ prompt, targetAgent: agent, source: "telegram" }, { chatId });
      return result.task ? { taskId: result.task.id } : { error: String(typeof result.error === "string" ? result.error : "invalid task") };
    },
    queueText: () => {
      const active = [...tasks.values()].filter((t) => !TERMINAL_STATUSES.includes(t.status));
      return active.map((t) => `${t.id.slice(0, 8)} ${t.status} ${t.targetAgent}: ${t.prompt.slice(0, 60)}`).join("\n") || "Queue is empty.";
    },
    log: (event, summary) => hive.log("telegram", event, summary),
  });
  telegram.start();
}

// --- Routes -----------------------------------------------------------------
app.get("/health", async (_req: Request, res: Response) => {
  let ollama: string | null = null;
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/version`, { signal: AbortSignal.timeout(2000) });
    ollama = ((await r.json()) as { version: string }).version;
  } catch {
    // reported as null below
  }
  res.status(200).json({ status: "ok", service: "ts-harness", port: PORT, model: OLLAMA_MODEL, ollama });
});

// GPU and queue state for the Mission Control system tile
app.get("/api/system", async (_req: Request, res: Response) => {
  const queueInfo = {
    running: runningTaskId,
    queued: queue.length,
    fastModel: OLLAMA_FAST_MODEL,
    telegram: Boolean(telegram),
    obsidian: Boolean(OBSIDIAN_VAULT),
    memories: memory.list().length,
  };
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/ps`, { signal: AbortSignal.timeout(2000) });
    const ps = (await r.json()) as { models?: { name: string; size: number; size_vram: number }[] };
    const models = (ps.models ?? []).map((m) => ({
      name: m.name,
      sizeGB: Math.round((m.size / 1024 ** 3) * 10) / 10,
      vramPct: m.size > 0 ? Math.round((100 * m.size_vram) / m.size) : 0,
    }));
    res.json({ ollama: "up", url: OLLAMA_BASE_URL, model: OLLAMA_MODEL, models, ...queueInfo });
  } catch {
    res.json({ ollama: "down", url: OLLAMA_BASE_URL, model: OLLAMA_MODEL, models: [], ...queueInfo });
  }
});

app.get("/api/agent/stream", handleStream);
app.post("/api/agent/run", requireToken, (req, res) => enqueue(req.body, res));
app.post("/api/agent/:id/cancel", requireToken, (req, res) => cancel(String(req.params.id), res));

app.get("/api/tasks", (_req: Request, res: Response) => {
  const list = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map(summarize);
  res.json(list);
});

app.get("/api/tasks/:id", (req: Request, res: Response) => {
  const task = tasks.get(String(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });
  res.json({ ...summarize(task), events: task.events });
});

// Team, hive mind and memory
app.get("/api/agents", (_req, res) => {
  res.json(AGENT_KEYS.map((k) => ({ key: k, name: TEAM[k].name, role: TEAM[k].role, canDelegate: k === "planner" })));
});
app.get("/api/hive", (req, res) => {
  res.json(hive.recent(Math.min(Number(req.query.limit) || 100, 500)));
});
app.get("/api/memories", (_req, res) => res.json(memory.list()));
app.post("/api/memories", requireToken, (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const id = memory.add(text, "shared", 0.7, req.body?.pinned !== false);
  if (id === null) return res.status(400).json({ error: "Memory text is too short" });
  res.status(201).json({ id });
});
app.post("/api/memories/maintain", requireToken, (_req, res) => res.json(memory.maintain()));
app.post("/api/memories/:id/:action", requireToken, (req, res) => {
  const id = Number(req.params.id);
  const action = String(req.params.action);
  const ok =
    action === "pin" ? memory.setPinned(id, true) : action === "unpin" ? memory.setPinned(id, false) : action === "delete" ? memory.remove(id) : null;
  if (ok === null) return res.status(400).json({ error: "Unknown action" });
  res.status(ok ? 200 : 404).json({ ok });
});

// Legacy routes from the earlier harness (voice Jarvis and old clients)
app.get("/stream", handleStream);
app.post("/command", requireToken, (req, res) => enqueue(req.body, res));
app.post("/cancel", requireToken, (req, res) => cancel(req.body?.taskId, res));

app.listen(PORT, HOST, () => {
  console.log(`ts-harness listening on http://${HOST}:${PORT}`);
  console.log(`Ollama: ${OLLAMA_BASE_URL}  model: ${OLLAMA_MODEL}  fast: ${OLLAMA_FAST_MODEL}  num_ctx: ${OLLAMA_NUM_CTX}`);
  console.log(`Data: ${DATA_DIR}  Obsidian: ${OBSIDIAN_VAULT || "off"}  Telegram: ${telegram ? "on" : "off"}`);
});
