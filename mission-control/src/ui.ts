import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import crypto from "crypto";
import {
  AgentStatus,
  AgentStreamPayload,
  AgentTarget,
  AgentTaskSchema,
  TaskSummary,
  TERMINAL_STATUSES,
} from "./schemas/agent";

// --- Config (env vars, see .env.example) ------------------------------------
const PORT = Number(process.env.PORT) || 3008;
// Localhost only unless told otherwise; the compose file sets 0.0.0.0 inside the container
const HOST = process.env.HOST || "127.0.0.1";
// Native Windows Ollama on the RX 9060 XT (port 11435, see setup-ollama.ps1)
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11435").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:14b";
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

const SYSTEM_PROMPTS: Record<AgentTarget, string> = {
  planner:
    "You are Jarvis, a local AI engineering assistant running on WSL2. Break the request into clear, numbered steps and call out risks or missing information.",
  coder:
    "You are Jarvis Coder, an expert TypeScript and Python engineer. Answer with working code and a short explanation. Prefer small, testable changes.",
  browser:
    "You are Jarvis Browser, a web research assistant. You cannot browse yet, so say what you would search for and which sources you would check, then answer from what you know.",
  file:
    "You are Jarvis File, an assistant for the user's vault and local files. You cannot read files yet, so explain which files or notes you would need and how you would organize them.",
  security_audit:
    "You are Jarvis Defensive Security Auditor. Review the described system for exposed ports, weak configuration and missing hardening, and give prioritized, defensive fixes.",
};

// Voice answers are read aloud by ~/sandcastle/src/agent_engine.py
// (evals: voice-math, voice-explain)
const VOICE_STYLE =
  "This request was spoken and your answer will be read aloud, so these rules override any formatting instructions above: " +
  "give the direct answer in your first sentence, then at most two short sentences of context. " +
  "Use plain sentences only, with no markdown, numbered steps, lists or headings. " +
  "Do not write code unless the user explicitly asks for code; if they do, put it in one fenced block after a one-sentence summary.";

// --- Task state -------------------------------------------------------------
interface Task extends TaskSummary {
  events: AgentStreamPayload[];
  controller?: AbortController;
  abortReason?: "user" | "timeout";
}

const tasks = new Map<string, Task>();
const queue: string[] = [];
let runningTaskId: string | null = null;
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
  const { events, controller, abortReason, ...summary } = task;
  return summary;
}

function agentLabel(task: Task) {
  return `Jarvis (${task.targetAgent})`;
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
  const flushTimer = setInterval(flush, 100);

  try {
    emit(task, "thinking");
    const body: Record<string, unknown> = {
      model: task.model,
      messages: [
        {
          role: "system",
          content: task.source === "voice" ? `${SYSTEM_PROMPTS[task.targetAgent]} ${VOICE_STYLE}` : SYSTEM_PROMPTS[task.targetAgent],
        },
        { role: "user", content: task.prompt },
      ],
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
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
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
        pending += parsed.message?.content ?? "";
      }
    }
    flush();
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
  } finally {
    clearTimeout(timeout);
    clearInterval(flushTimer);
    task.finishedAt = Date.now();
    task.controller = undefined;
  }
}

// One task at a time: two agents sharing one GPU each run at half speed
async function pump() {
  if (runningTaskId) return;
  const nextId = queue.shift();
  if (!nextId) return;
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

function pruneHistory() {
  const finished = [...tasks.values()]
    .filter((t) => TERMINAL_STATUSES.includes(t.status))
    .sort((a, b) => a.createdAt - b.createdAt);
  while (tasks.size > MAX_TASK_HISTORY && finished.length) {
    tasks.delete(finished.shift()!.id);
  }
}

function enqueue(input: unknown, res: Response) {
  const parsed = AgentTaskSchema.safeParse(input);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (queue.length >= MAX_QUEUE) {
    return res.status(429).json({ error: `Queue is full (${MAX_QUEUE} tasks)` });
  }
  const id = parsed.data.id ?? crypto.randomUUID();
  if (tasks.has(id)) {
    return res.status(409).json({ error: "A task with this id already exists" });
  }
  const task: Task = {
    id,
    prompt: parsed.data.prompt,
    targetAgent: parsed.data.targetAgent,
    source: parsed.data.source,
    model: parsed.data.model ?? OLLAMA_MODEL,
    status: "queued",
    createdAt: Date.now(),
    events: [],
  };
  tasks.set(id, task);
  queue.push(id);
  emit(task, "queued", `> ${task.prompt}\n\n`);
  // position 0 means it starts right away
  res.status(202).json({ taskId: id, position: runningTaskId ? queue.length : 0 });
  void pump();
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
  } else {
    task.abortReason = "user";
    task.controller?.abort();
  }
  res.status(200).json({ status: "canceled", taskId: task.id });
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
  const queueInfo = { running: runningTaskId, queued: queue.length };
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

// Legacy routes from the earlier harness (voice Jarvis and old clients)
app.get("/stream", handleStream);
app.post("/command", requireToken, (req, res) => enqueue(req.body, res));
app.post("/cancel", requireToken, (req, res) => cancel(req.body?.taskId, res));

app.listen(PORT, HOST, () => {
  console.log(`ts-harness listening on http://${HOST}:${PORT}`);
  console.log(`Ollama: ${OLLAMA_BASE_URL}  model: ${OLLAMA_MODEL}  num_ctx: ${OLLAMA_NUM_CTX}`);
});
