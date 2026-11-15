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
  TaskPatchSchema,
  TaskReplySchema,
  TaskSummary,
  TERMINAL_STATUSES,
  boardColumn,
} from "./schemas/agent";
import { BrowserSession, Frame } from "./hq/browser";
import { runBrowserAgent } from "./hq/browser-agent";
import { StreamGuard, redact } from "./hq/guard";
import { Hive } from "./hq/hive";
import { Memory } from "./hq/memory";
import { ModelGateway } from "./hq/gateway";
import type { CallOptions } from "./hq/gateway";
import { deliveryText, hiveSummary, isRoutine, routineFields, routinePatchError, saveRoutineNote } from "./hq/routine";
import { MODEL_ROLES, ModelRegistry, ModelRole, parseSwitchCommand, resolveTarget } from "./hq/models";
import { Notices } from "./hq/notices";
import type { ChatMessage, JsonChat } from "./hq/ollama";
import { checkProvider, listModels } from "./hq/providers";
import { RUNNING_STATUSES, Task, TaskStore, pickNext, waitingOn } from "./hq/taskstore";
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
import { privateBlock } from "./hq/privacy";
import { Uploads } from "./hq/uploads";
import { splitWav } from "./hq/wav";
import { closeRound, historyMessages } from "./hq/thread";
import { FILE_ID, Files, buildReport, pdfInstructions, printPdf, wantsPdf } from "./hq/pdf";
import { DOC_ID, DocCache, cleanName, extractPdf, partsOf, withPageMarks } from "./hq/docs";
import type { PdfText } from "./hq/docs";
import { Scheduler } from "./hq/scheduler";
import { upcoming, parseSchedule, validTimeZone } from "./hq/schedule";

// --- Config (env vars, see .env.example) ------------------------------------
const PORT = Number(process.env.PORT) || 3008;
// Localhost only unless told otherwise; the compose file sets 0.0.0.0 inside the container
const HOST = process.env.HOST || "127.0.0.1";
// Native Windows Ollama on the RX 9060 XT (port 11435, see setup-ollama.ps1)
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11435").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:14b";
// Default for the router and memory roles; falls back to OLLAMA_MODEL
const OLLAMA_FAST_MODEL = process.env.OLLAMA_FAST_MODEL || OLLAMA_MODEL;
// Default for the vision agent; it must be able to read images (qwen3.5, gemma4:12b, ...)
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "qwen3.5:latest";
// Default for transcribing audio; it must have the audio capability (gemma4:12b) or be a Whisper server
const OLLAMA_AUDIO_MODEL = process.env.OLLAMA_AUDIO_MODEL || "gemma4:12b";
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";
const OLLAMA_THINK = process.env.OLLAMA_THINK === "true";
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS) || 10 * 60 * 1000;
const MAX_QUEUE = Number(process.env.MAX_QUEUE) || 20;
// How long the front of the queue may wait while same-model tasks run first
const MODEL_GROUP_MAX_WAIT_MS = Number(process.env.MODEL_GROUP_MAX_WAIT_MS) || 60_000;
// Overall cloud spend cap until one is saved on the Team page; "none" starts with no cap
const DEFAULT_MONTHLY_BUDGET_USD =
  process.env.MONTHLY_BUDGET_USD === "none" ? undefined : Number.isFinite(Number(process.env.MONTHLY_BUDGET_USD)) && process.env.MONTHLY_BUDGET_USD ? Number(process.env.MONTHLY_BUDGET_USD) : 20;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
// Optional bearer token for the endpoints that start, stop or change work
const HARNESS_TOKEN = process.env.HARNESS_TOKEN || "";
// HQ features (see README-HQ.md)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || "";
const MEMORY_INTERVAL_MIN = Number(process.env.MEMORY_INTERVAL_MIN) || 30;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);
// Real browsing: a Chrome DevTools endpoint, e.g. http://browser:9222 (docker-compose.yml)
const BROWSER_CDP_URL = process.env.BROWSER_CDP_URL || "";
const BROWSER_MAX_STEPS = Number(process.env.BROWSER_MAX_STEPS) || 10;
// Only for testing against pages on your own machine; keep false otherwise
const BROWSER_ALLOW_PRIVATE = process.env.BROWSER_ALLOW_PRIVATE === "true";

// Voice answers are read aloud by ~/sandcastle/src/agent_engine.py
// (evals: voice-math, voice-explain)
const VOICE_STYLE =
  "This request was spoken and your answer will be read aloud, so these rules override any formatting instructions above: " +
  "give the direct answer in your first sentence, then at most two short sentences of context. " +
  "Use plain sentences only, with no markdown, numbered steps, lists or headings. " +
  "Do not write code unless the user explicitly asks for code; if they do, put it in one fenced block after a one-sentence summary.";

// --- State ------------------------------------------------------------------
const store = new TaskStore(DATA_DIR);
const { recovered } = store.load();
const models = new ModelRegistry(store, {
  model: OLLAMA_MODEL,
  fastModel: OLLAMA_FAST_MODEL,
  visionModel: OLLAMA_VISION_MODEL,
  audioModel: OLLAMA_AUDIO_MODEL,
  numCtx: OLLAMA_NUM_CTX,
  think: OLLAMA_THINK,
  monthlyBudgetUsd: DEFAULT_MONTHLY_BUDGET_USD,
  // "switch Jarvis to colibri" / "colibri-big", when a colibri server is configured
  colibriModel: process.env.COLIBRI_BASE_URL ? process.env.COLIBRI_MODEL || undefined : undefined,
  colibriBigModel: process.env.COLIBRI_BASE_URL ? process.env.COLIBRI_BIG_MODEL || undefined : undefined,
});

/**
 * How long a task may run: TASK_TIMEOUT_MS, or longer when its agent has its own
 * time limit. Jarvis may hand work to any teammate, so it gets the longest one.
 */
function taskTimeoutMs(agent: string | undefined, delegates: boolean): number {
  const roles = delegates ? AGENT_KEYS : AGENT_KEYS.filter((k) => k === agent);
  return Math.max(TASK_TIMEOUT_MS, ...roles.map((r) => models.timeoutMs(r) ?? 0));
}
const uploads = new Uploads(DATA_DIR);
const files = new Files(path.join(DATA_DIR, "files"));
const docCache = new DocCache(path.join(DATA_DIR, "uploads"));
// A long PDF is read in at most this many parts (about 14,000 characters each)
const MAX_DOC_PARTS = Number(process.env.MAX_DOC_PARTS) || 10;

/** A PDF's text, from the cache or pulled out again. */
async function docText(id: string): Promise<PdfText | null> {
  const cached = docCache.get(id);
  if (cached) return cached;
  const buf = DOC_ID.test(id) ? uploads.bytes(id) : null;
  if (!buf) return null;
  const doc = await extractPdf(buf);
  docCache.set(id, doc);
  return doc;
}
const hive = new Hive(DATA_DIR);
const notices = new Notices(store);
// Every model request goes through the gateway: local-only lock, spend caps, private-context rule
const gateway = new ModelGateway(models, store, notices, OLLAMA_KEEP_ALIVE);
gateway.onServed = (ref) => {
  lastModelRef = ref;
};
const tasks = store.tasks;

let runningTaskId: string | null = null;
let lastModelRef: string | null = null;
// Memory extraction runs between tasks so it never competes with one for the GPU
const memoryJobs: { agent: AgentTarget; prompt: string; answer: string; private: boolean }[] = [];
let backgroundBusy = false;
// Ids keep increasing across restarts, so a reconnecting UI never mistakes
// new events for ones it already has
let nextEventId = Math.max(Date.now(), store.maxEventId() + 1);

const app = express();
app.use(cors({ origin: CORS_ORIGINS }));
// Room for a 25 MB PDF or audio clip (or a 10 MB picture) sent as base64
app.use(express.json({ limit: "40mb" }));

function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!HARNESS_TOKEN || req.headers.authorization === `Bearer ${HARNESS_TOKEN}`) return next();
  res.status(401).json({ error: "Missing or invalid bearer token" });
}

function summarize(task: Task): TaskSummary {
  const { events, controller, abortReason, requestedAgent, activeAgent, chatId, answer, queuedAt, modelOverride, privateNotes, thread, ...summary } = task;
  // Lists only need how many replies a card has; the detail view sends the thread itself
  return thread?.length ? { ...summary, replies: thread.length / 2 } : summary;
}

function agentLabel(task: Task) {
  return `Jarvis (${task.activeAgent ?? task.targetAgent})`;
}

// --- Models -----------------------------------------------------------------
/** A JSON-mode chat for one role (router, memory, browser steps), through the gateway. */
function roleJson(role: ModelRole, opts: CallOptions = {}): JsonChat {
  return async (_model, messages) => {
    const out = await gateway.json(role, messages, (note) => hive.log(role, "policy", note), opts);
    return out.json ?? {};
  };
}

const memory = new Memory(DATA_DIR, roleJson("memory"), "memory");

/** The model a queued task will run on, for grouping same-model work (null when auto-routed). */
function plannedModel(t: Task): string | null {
  if (t.modelOverride) return models.resolve(t.targetAgent, t.modelOverride).ref;
  if (t.requestedAgent === "auto") return null;
  return models.resolve(t.targetAgent).ref;
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
  const changed = task.status !== status;
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
  store.appendEvent(payload);
  // Streaming chunks don't change the card, so only status changes rewrite it
  if (changed) store.save(task);
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
  // ?replay=all on the first connect sends the recent history.
  const header = req.headers["last-event-id"];
  const lastId = header ? Number(header) : req.query.replay === "all" ? 0 : NaN;
  if (Number.isFinite(lastId)) {
    const missed = [...tasks.values()]
      .filter((t) => !t.parentId && (!taskId || t.id === taskId))
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

// --- Browser live view --------------------------------------------------------
// Frames from the browser agent's Chrome go to the dashboard's Browser tab over
// their own event stream, capped at ~5 frames a second.
type BrowserEvent =
  | { type: "frame"; taskId: string; data: string; url: string; title: string }
  | { type: "start" | "end"; taskId: string; task?: string }
  | { type: "action"; taskId: string; kind: string; line: string }
  | { type: "blocked"; taskId: string; url: string; reason: string };
const browserClients = new Set<Response>();
let lastFrame: BrowserEvent | null = null;
let lastFrameSentAt = 0;
const browserLog: BrowserEvent[] = [];

function broadcastBrowser(event: BrowserEvent) {
  if (event.type === "frame") {
    lastFrame = event;
    const now = Date.now();
    if (now - lastFrameSentAt < 200) return;
    lastFrameSentAt = now;
  } else {
    browserLog.push(event);
    if (browserLog.length > 60) browserLog.shift();
  }
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of browserClients) res.write(line);
}

function handleBrowserStream(req: Request, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  for (const e of browserLog) res.write(`data: ${JSON.stringify(e)}\n\n`);
  if (lastFrame) res.write(`data: ${JSON.stringify(lastFrame)}\n\n`);
  browserClients.add(res);
  req.on("close", () => browserClients.delete(res));
}

setInterval(() => {
  for (const res of browserClients) res.write(": ping\n\n");
}, 15000);

// --- Agent turns ------------------------------------------------------------

interface TurnResult {
  text: string;
  /** The model that actually answered (after any lock, cap or fallback) */
  ref?: string;
  /** The turn saw private material, so its output is private too */
  sawPrivate: boolean;
}

/**
 * Streams one agent turn into the task's output (through the exfiltration
 * guard). The gateway picks the model and applies the lock, caps and privacy
 * rule; its notes (fallbacks, budgets) are shown inline.
 */
async function streamTurn(
  task: Task,
  role: AgentTarget,
  messages: ChatMessage[],
  signal: AbortSignal,
  push: (text: string) => void,
  override?: string,
  privateTask = false,
): Promise<TurnResult> {
  const guard = new StreamGuard();
  try {
    const out = await gateway.stream(
      role,
      messages,
      signal,
      (piece) => push(guard.push(piece)),
      (note) => {
        push(guard.end());
        push(`\n[${note}]\n\n`);
        hive.log(role, "policy", note, task.id);
      },
      override,
      { privateTask },
    );
    // A turn working from private instructions produces private output, whatever model ran it
    return { text: out.text, ref: out.ref, sawPrivate: out.sawPrivate || privateTask };
  } finally {
    push(guard.end());
    if (guard.found.size) hive.log("guard", "redacted", [...guard.found].join(", "), task.id);
  }
}

// The system prompt only holds text that stays the same between calls, so
// Ollama can reuse its cached work for it; see teamContext in hq/team.ts.
const READ_ONLY_RULES =
  "\n\nTHIS IS A READ-ONLY RUN: look things up and report back only. Don't submit, change, buy, sign up for or delete anything.";

function systemPrompt(task: Task, agent: AgentTarget, opts: { team: boolean; delegate: boolean }) {
  let system = TEAM[agent].prompt;
  if (task.source === "voice") system += ` ${VOICE_STYLE}`;
  if (opts.delegate) system += DELEGATION_RULES;
  if (task.readOnly) system += READ_ONLY_RULES;
  if (agent === "file" && OBSIDIAN_VAULT && task.source !== "voice" && !task.readOnly) system += NOTE_RULES;
  if (opts.team) system += teamContext(agent, vaultNotes(OBSIDIAN_VAULT, agent));
  return system;
}

// The parts that change on every call ride along with the request
function userMessage(agent: AgentTarget, text: string, recallFor: string, team: boolean) {
  if (!team) return text;
  return withLiveContext(text, { hive: hive.promptText(), hivePublic: hive.publicText(), memories: memory.recall(recallFor, agent) });
}

const browsingEnabled = (task: Task) => Boolean(BROWSER_CDP_URL) && task.source !== "eval";

/** Sites a read-only run may open: the card's list, or the sites named in its prompt, plus web search. */
function readOnlySites(task: Task): string[] {
  const named = task.allowedSites?.length
    ? task.allowedSites
    : [...`${task.prompt} ${task.reply ?? ""}`.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase().replace(/^www\./, ""));
  return [...new Set([...named, "html.duckduckgo.com"])];
}

/** Drives the real browser for one request and returns the agent's answer. */
async function browse(task: Task, request: string, signal: AbortSignal, push: (text: string) => void, privateTask = false) {
  const sites = task.readOnly ? readOnlySites(task) : [];
  const session = new BrowserSession({
    allowPrivate: BROWSER_ALLOW_PRIVATE,
    readOnly: task.readOnly ? { allowedSites: sites } : undefined,
    onFrame: (f: Frame) => broadcastBrowser({ type: "frame", taskId: task.id, ...f }),
    onBlocked: (url, reason) => {
      broadcastBrowser({ type: "blocked", taskId: task.id, url, reason });
      hive.log("browser", "blocked", `${url} (${reason})`, task.id);
    },
  });
  await session.start(BROWSER_CDP_URL);
  if (task.readOnly && sites.length === 1) {
    // Only web search is allowed: the run can read result snippets but open no result
    const msg = "This read-only run names no sites, so the browser can only read search results. Add allowed sites to the card to let it open pages.";
    push(`[${msg}]\n\n`);
    notices.add("read-only", "read-only:no-sites", msg);
  }
  broadcastBrowser({ type: "start", taskId: task.id, task: request });
  emit(task, "executing_tool");
  try {
    const answer = await runBrowserAgent({
      task: request,
      session,
      chat: roleJson("browser", { privateTask }),
      model: "browser",
      maxSteps: BROWSER_MAX_STEPS,
      signal,
      extraRules:
        [
          task.readOnly
            ? `READ-ONLY RUN: you may only open pages on ${sites.join(", ")} and follow links there. Typing, buttons and forms are disabled; use web search via navigate.`
            : "",
          task.source === "voice" ? `When you answer: ${VOICE_STYLE}` : "",
        ]
          .filter(Boolean)
          .join("\n") || undefined,
      log: (line, kind) => {
        push(kind === "action" ? `🌐 ${line}\n` : `   ${kind === "error" ? "✗" : "✓"} ${line}\n`);
        broadcastBrowser({ type: "action", taskId: task.id, kind, line });
      },
    });
    push(`\n${redact(answer).text}`);
    return { text: answer, sawPrivate: privateTask };
  } finally {
    await session.close();
    broadcastBrowser({ type: "end", taskId: task.id });
  }
}

/** One agent's turn: the real browser for the browser agent when enabled, otherwise a model call. */
async function agentTurn(
  task: Task,
  agent: AgentTarget,
  messages: ChatMessage[],
  request: string,
  signal: AbortSignal,
  push: (text: string) => void,
  override?: string,
  /** The request was written by a lead that had seen private material */
  privateTask = false,
): Promise<TurnResult> {
  if (agent === "browser" && browsingEnabled(task)) {
    try {
      return await browse(task, request, signal, push, privateTask);
    } catch (error) {
      if (signal.aborted) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      push(`\n[Browser unavailable (${msg}); answering without it.]\n\n`);
      hive.log("browser", "error", msg, task.id);
    }
  }
  return streamTurn(task, agent, messages, signal, push, override, privateTask);
}

/** A board record for a delegated piece of work, shown under its parent card. */
function addSubtask(parent: Task, agent: AgentTarget, prompt: string): Task {
  const sub: Task = {
    id: crypto.randomUUID(),
    parentId: parent.id,
    prompt,
    title: prompt.split("\n")[0].slice(0, 80),
    targetAgent: agent,
    requestedAgent: agent,
    routedBy: "user",
    source: parent.source,
    model: models.resolve(agent).ref,
    status: "thinking",
    createdAt: Date.now(),
    startedAt: Date.now(),
    events: [],
  };
  store.add(sub);
  return sub;
}

function finishSubtask(sub: Task, status: AgentStatus, answer?: string, error?: string) {
  sub.status = status;
  sub.answer = answer ? redact(answer).text.slice(0, 20000) : undefined;
  sub.error = error;
  sub.finishedAt = Date.now();
  store.save(sub);
}

async function runTask(task: Task) {
  const controller = new AbortController();
  task.controller = controller;
  task.startedAt = Date.now();
  task.attempts = (task.attempts ?? 0) + 1;
  // Routine runs are read-only whatever the stored card says
  if (isRoutine(task)) task.readOnly = true;
  const onTimeout = () => {
    task.abortReason = "timeout";
    controller.abort();
  };
  let limitMs = taskTimeoutMs(task.targetAgent, task.targetAgent === "planner");
  let timeout = setTimeout(onTimeout, limitMs);
  // Once the lead agent is known (after auto-routing), a slower agent can extend the limit
  const extendLimit = (agent: string, delegates: boolean) => {
    const want = taskTimeoutMs(agent, delegates);
    if (want <= limitMs) return;
    clearTimeout(timeout);
    timeout = setTimeout(onTimeout, Math.max(0, want - (Date.now() - task.startedAt!)));
    limitMs = want;
  };

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
    if (useTeam) hive.log(agent, event, hiveSummary(task, event, summary), task.id);
  };
  let openSub: Task | null = null;

  try {
    // A reply to a finished card continues its conversation: the current round answers
    // the reply, with the earlier turns as history
    const ask = task.reply ?? task.prompt;
    const history = historyMessages(task.thread);
    const followUp = history.length > 0;
    // "…as a PDF": the answer is written as a document and printed when the run ends
    const makePdf = wantsPdf(ask);
    const pdfNote = makePdf ? pdfInstructions(task.images ?? []) : "";
    const learned: string[] = [];
    const images = (task.images ?? []).map((id) => uploads.base64(id)).filter((b): b is string => Boolean(b));

    // Audio is transcribed first. The transcript is private, like the audio itself.
    let transcriptBlock = "";
    let transcript = "";
    let heardPrivate = false;
    const clips = (task.audio ?? []).map((id) => uploads.bytes(id)).filter((b): b is Buffer => Boolean(b));
    if (clips.length) {
      emit(task, "executing_tool", `── Transcribing ${clips.length} audio clip${clips.length > 1 ? "s" : ""} (${models.resolve("audio").ref}) ──\n\n`);
      const parts: string[] = [];
      for (const [i, clip] of clips.entries()) {
        const texts: string[] = [];
        // Audio models take short clips (Gemma 4: 30 s), so long recordings go in pieces
        for (const piece of splitWav(clip)) {
          const out = await gateway.transcribe(piece, controller.signal, (note) => {
            push(`[${note}]\n`);
            hive.log("audio", "policy", note, task.id);
          });
          texts.push(out.text);
        }
        const text = texts.join(" ").replace(/\s+/g, " ").trim();
        parts.push(clips.length > 1 ? `Clip ${i + 1}: ${text || "(no speech found)"}` : text || "(no speech found)");
      }
      transcript = parts.join("\n\n");
      push(`${transcript}\n\n`);
      flush();
      heardPrivate = true;
      learned.push(`Transcript of the attached audio:\n${transcript}`);
      transcriptBlock = privateBlock(
        `TRANSCRIPT OF THE ATTACHED AUDIO:\n${transcript}`,
        "(The attached audio and its transcript stay on the user's PC and are withheld from cloud models.)",
      );
    }

    // Attached PDFs: short ones go to the agent whole; long ones are read in parts by
    // Jarvis File, which keeps what matters for the request. Their text is private.
    let docsBlock = "";
    let docPeek = "";
    const docIds = task.documents ?? [];
    if (docIds.length) {
      emit(task, "executing_tool", `── Reading ${docIds.length} PDF${docIds.length > 1 ? "s" : ""} (${models.resolve("file").ref}) ──\n\n`);
      // Leave room in the model's context for instructions, history and the answer
      const budget = Math.max(6000, Math.floor((OLLAMA_NUM_CTX * 2.4) / docIds.length));
      const sections: string[] = [];
      for (const id of docIds) {
        let doc: PdfText | null;
        try {
          doc = await docText(id);
        } catch (e) {
          push(`[${e instanceof Error ? e.message : String(e)}]\n`);
          continue;
        }
        if (!doc) {
          push("[An attached PDF is missing from the uploads folder]\n");
          continue;
        }
        const label = `"${doc.name}" (${doc.totalPages} page${doc.totalPages === 1 ? "" : "s"}${doc.totalPages > doc.pages.length ? `, first ${doc.pages.length} read` : ""})`;
        if (doc.scanned) push(`[${doc.name} has little or no text, so it may be scanned. Attach screenshots of its pages as pictures for Vision to read.]\n`);
        const whole = withPageMarks(doc);
        docPeek ||= whole.slice(0, 600);
        if (whole.length <= budget) {
          push(`${label}: given in full (${whole.length.toLocaleString("en-US")} characters).\n`);
          sections.push(`CONTENTS OF THE ATTACHED PDF ${label}:\n${whole}`);
          continue;
        }
        const parts = partsOf(doc, Math.min(budget, 14000));
        const kept = parts.slice(0, MAX_DOC_PARTS);
        push(`${label} is long: reading it in ${kept.length} parts${parts.length > kept.length ? ` (pages ${kept[kept.length - 1].to + 1}–${doc.pages.length} are skipped)` : ""}.\n`);
        const notes: string[] = [];
        for (const [k, part] of kept.entries()) {
          const out = await gateway.stream(
            "file",
            [
              { role: "system", content: "You are Jarvis File. You read one part of a document for another agent and write notes it can answer from." },
              {
                role: "user",
                content:
                  `REQUEST: ${ask}\n\nPART ${k + 1} OF ${kept.length} of ${label}, pages ${part.from + 1}–${part.to}:\n` +
                  `${privateBlock(part.text, "(This part of the document is withheld from cloud models.)")}\n\n` +
                  "Write concise notes (at most 200 words) on everything in this part that helps with the request: facts, figures, names, dates and short quotes, each with its page number. " +
                  "If nothing here is relevant, reply only: Nothing relevant.",
              },
            ],
            controller.signal,
            () => {},
            (note) => {
              push(`[${note}]\n`);
              hive.log("file", "policy", note, task.id);
            },
          );
          const text = out.text.trim();
          const nothing = /^nothing relevant\.?$/i.test(text);
          push(`  pages ${part.from + 1}–${part.to}: ${nothing ? "nothing relevant" : "notes taken"}\n`);
          if (!nothing && text) notes.push(`Pages ${part.from + 1}–${part.to}:\n${text}`);
        }
        sections.push(
          `NOTES ON THE ATTACHED PDF ${label}, read in ${kept.length} parts by Jarvis File (cite the page numbers):\n` +
            (notes.join("\n\n") || "(No part of the document was relevant to the request.)"),
        );
      }
      push("\n");
      flush();
      if (sections.length) {
        heardPrivate = true;
        learned.push(sections.join("\n\n").slice(0, 6000));
        docsBlock = privateBlock(sections.join("\n\n"), "(The attached PDFs and their contents stay on the user's PC and are withheld from cloud models.)");
      }
    }

    if (task.requestedAgent === "auto" && images.length) {
      // Pictures go to the agent that can see them
      task.targetAgent = "vision";
      task.routedBy = "router";
      log("router", "routed", `→ vision (pictures attached): ${ask}`);
    } else if (task.requestedAgent === "auto") {
      emit(task, "routing");
      // Route on what was said too; the router's text limit can't cut a private block open
      const routeAsk = followUp ? `Follow-up to: ${task.prompt.slice(0, 300)}\nReply: ${ask}` : ask;
      const extras = [transcript && `AUDIO TRANSCRIPT: ${transcript.slice(0, 600)}`, docPeek && `START OF THE ATTACHED PDF: ${docPeek}`].filter(Boolean).join("\n\n");
      const routeText = extras ? `${routeAsk.slice(0, 1100)}\n\n${privateBlock(extras, "(audio or a PDF is attached)")}` : routeAsk;
      const routed = await routeTask(roleJson("router"), "router", routeText);
      task.targetAgent = routed.agent;
      task.routedBy = routed.reason === "keyword match" ? "keywords" : "router";
      log("router", "routed", `→ ${routed.agent} (${routed.reason}): ${ask}`);
    } else {
      log(task.targetAgent, "assigned", ask);
    }

    const lead = task.targetAgent;
    // A model picked for this task (evals compare models) beats the agent's own setting
    const override = task.modelOverride;
    task.model = models.resolve(lead, override).ref;
    store.save(task);
    const delegate = canDelegate && lead === "planner";
    extendLimit(lead, delegate);
    let usedPrivate = heardPrivate;

    // Only the vision agent can see pictures. When another agent leads, Vision reads
    // them first and the lead gets its description, which is private like the pictures.
    let request = [ask, transcriptBlock, docsBlock].filter(Boolean).join("\n\n");
    if (images.length && lead !== "vision") {
      openSub = addSubtask(task, "vision", `Describe the ${images.length} attached picture(s) for: ${ask}`);
      task.activeAgent = "vision";
      emit(task, "delegating", `── ${TEAM.vision.name} (${openSub.model}) ── reading ${images.length} picture(s)\n\n`);
      emit(task, "thinking");
      const seen = await streamTurn(
        task,
        "vision",
        [
          { role: "system", content: systemPrompt(task, "vision", { team: false, delegate: false }) },
          {
            role: "user",
            content: `Describe what the attached picture(s) show, in the detail another agent needs for this request:\n${request}`,
            images,
          },
        ],
        controller.signal,
        push,
      );
      if (seen.ref) openSub.model = seen.ref;
      finishSubtask(openSub, "complete", seen.text);
      openSub = null;
      usedPrivate ||= seen.sawPrivate;
      learned.push(`Description of the attached pictures:\n${seen.text}`);
      task.activeAgent = lead;
      flush();
      emit(task, "thinking", `\n\n── ${TEAM[lead].name} ──\n\n`);
      request = `${request}\n\n${privateBlock(
        `DESCRIPTION OF THE ATTACHED PICTURES (from Jarvis Vision):\n${seen.text}`,
        "(The attached pictures and their description stay on the user's PC and are withheld from cloud models.)",
      )}`;
    } else {
      emit(task, "thinking");
    }
    request += pdfNote;

    const firstTurn = await agentTurn(
      task,
      lead,
      [
        { role: "system", content: systemPrompt(task, lead, { team: useTeam, delegate }) },
        ...history,
        {
          role: "user",
          content: userMessage(lead, request, ask, useTeam),
          ...(lead === "vision" && images.length ? { images } : {}),
        },
      ],
      // The browser agent works from this text alone, so a reply carries the original request
      (followUp ? `${ask}\n\n(This follows up on the earlier request: ${task.prompt.slice(0, 500)})` : ask) + pdfNote,
      controller.signal,
      push,
      override,
    );
    usedPrivate ||= firstTurn.sawPrivate;
    const first = firstTurn.text;
    // Show the model that really answered, which a cap or the local-only lock may have changed
    if (firstTurn.ref && firstTurn.ref !== task.model) {
      task.model = firstTurn.ref;
      store.save(task);
    }

    const handoffs = delegate ? parseDelegations(first) : [];
    let answer = first;
    if (handoffs.length) {
      task.delegatedTo = [];
      const results: { agent: AgentTarget; task: string; output: string; private: boolean }[] = [];
      for (const h of handoffs) {
        flush();
        task.activeAgent = h.agent;
        task.delegatedTo.push(h.agent);
        openSub = addSubtask(task, h.agent, h.task);
        log("planner", "delegated", `→ ${h.agent}: ${h.task}`);
        emit(task, "delegating", `\n\n── ${TEAM[h.agent].name} (${openSub.model}) ── ${h.task}\n\n`);
        emit(task, "thinking");
        const turn = await agentTurn(
          task,
          h.agent,
          [
            { role: "system", content: systemPrompt(task, h.agent, { team: true, delegate: false }) },
            {
              role: "user",
              content: userMessage(h.agent, h.task, h.task, true),
              // A handoff to Vision brings the card's pictures with it
              ...(h.agent === "vision" && images.length ? { images } : {}),
            },
          ],
          h.task,
          controller.signal,
          push,
          undefined,
          // The lead wrote these instructions after seeing private material, so they may
          // carry it: the teammate stays local unless it may send private context to the cloud
          firstTurn.sawPrivate,
        );
        const output = turn.text;
        usedPrivate ||= turn.sawPrivate;
        if (turn.ref) openSub.model = turn.ref;
        finishSubtask(openSub, "complete", output);
        openSub = null;
        // Remember which answers came from private material, so they're withheld if the lead runs in the cloud
        results.push({ agent: h.agent, task: h.task, output, private: turn.sawPrivate });
        log(h.agent, "finished", output);
      }
      flush();
      task.activeAgent = lead;
      emit(task, "thinking", `\n\n── ${TEAM[lead].name}: final answer ──\n\n`);
      const final = await streamTurn(
        task,
        lead,
        [
          { role: "system", content: systemPrompt(task, lead, { team: true, delegate: false }) },
          ...history,
          { role: "user", content: userMessage(lead, synthesisPrompt(ask, results) + pdfNote, ask, true) },
        ],
        controller.signal,
        push,
        override,
      );
      answer = final.text;
      usedPrivate ||= final.sawPrivate;
    }

    task.usedPrivate = usedPrivate || undefined;
    task.privateNotes = learned.join("\n\n") || undefined;
    // Read-only runs don't write to the vault
    const notes = task.readOnly ? [] : saveNotes(OBSIDIAN_VAULT, redact(answer).text);
    if (notes.length) push(`\n\n(Saved to vault: ${notes.map((n) => path.basename(n)).join(", ")})`);
    flush();
    task.answer = redact(answer.replace(/<note title="[^"]*">[\s\S]*?<\/note>/g, "")).text.trim();
    log(lead, "complete", task.answer);
    // Read-only runs don't save memories either
    if (useTeam && !task.readOnly && task.answer) memoryJobs.push({ agent: lead, prompt: ask, answer: task.answer, private: usedPrivate });
    if (makePdf && task.answer) {
      emit(task, "executing_tool", "\n\n── Making the PDF ──\n");
      const made = await makeReport(task);
      push(
        "error" in made
          ? `[PDF not made: ${made.error}]\n`
          : `📄 PDF saved: ${made.name}${made.pictures ? ` (${made.pictures} picture${made.pictures > 1 ? "s" : ""})` : ""}` +
              `${made.missing ? `; ${made.missing} picture link(s) couldn't be used` : ""}. Open it from the card.\n`,
      );
      flush();
    }
    emit(task, "complete");
  } catch (error: unknown) {
    flush();
    if (controller.signal.aborted) {
      if (task.abortReason === "timeout") {
        task.error = `Timed out after ${Math.round(limitMs / 1000)}s`;
        emit(task, "error", `\n\n[${task.error}]`);
      } else {
        emit(task, "canceled", "\n\n[Generation stopped]");
      }
    } else {
      task.error = error instanceof Error ? error.message : String(error);
      console.error(`Task ${task.id} failed:`, task.error);
      emit(task, "error", `\n\n[Error: ${task.error}]`);
    }
    if (openSub) finishSubtask(openSub, task.status === "canceled" ? "canceled" : "error", undefined, task.error);
    log(task.activeAgent ?? task.targetAgent, task.status, task.error ?? "canceled");
  } finally {
    clearTimeout(timeout);
    clearInterval(flushTimer);
    task.finishedAt = Date.now();
    task.controller = undefined;
    task.activeAgent = undefined;
    store.save(task);
    notifyDone(task);
  }
}

// --- Queue ------------------------------------------------------------------
// One task at a time: two agents sharing one GPU each run at half speed. The
// next task is picked by priority, board order and dependencies, preferring
// one that uses the model already loaded (see pickNext).
async function pump() {
  if (runningTaskId || backgroundBusy) return;
  const task = pickNext(tasks, { lastModel: lastModelRef, modelOf: plannedModel, maxWaitMs: MODEL_GROUP_MAX_WAIT_MS });
  if (!task) return runBackgroundJob();
  runningTaskId = task.id;
  try {
    await runTask(task);
  } finally {
    runningTaskId = null;
    store.trim();
    void pump();
  }
}

// Memory extraction only runs when no task is waiting
async function runBackgroundJob() {
  const job = memoryJobs.shift();
  if (!job) return;
  backgroundBusy = true;
  try {
    const saved = await memory.extract(job.agent, job.prompt, job.answer, job.private);
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

// --- Creating and changing cards ---------------------------------------------
const ROLE_LABEL: Record<string, string> = { planner: "Jarvis", coder: "Coder", browser: "Browser", file: "File", security_audit: "Security", vision: "Vision", router: "Router", memory: "Memory", audio: "Transcriber" };

/** "switch coder to claude" and friends change models without running a task. */
function handleSwitch(text: string): string | null {
  const cmd = parseSwitchCommand(text);
  if (!cmd) return null;
  const settings = models.settings();
  const ref = resolveTarget(cmd.target, settings, models.providers());
  if (!ref) {
    const aliases = Object.keys(settings.aliases).join(", ");
    return `I don't know a model called "${cmd.target}". Known names: ${aliases || "none"}. Add one on the Team page.`;
  }
  const roles = cmd.role === "all" ? AGENT_KEYS : [cmd.role];
  const err = models.update({ roles: Object.fromEntries(roles.map((r) => [r, { model: ref }])) as never });
  if (err) return err;
  hive.log("models", "switched", `${roles.join(", ")} → ${ref}`);
  return `${cmd.role === "all" ? "Every agent" : ROLE_LABEL[cmd.role]} now uses ${ref}.`;
}

function createTask(input: unknown, extra: { chatId?: string; routineId?: string } = {}): { task?: Task; status: number; error?: unknown } {
  const parsed = AgentTaskSchema.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.flatten() };
  const d = parsed.data;
  const id = d.id ?? crypto.randomUUID();
  if (tasks.has(id)) return { status: 409, error: "A task with this id already exists" };
  const queueIt = d.column === "ready";
  if (queueIt && store.queuedCount() >= MAX_QUEUE) return { status: 429, error: `Queue is full (${MAX_QUEUE} tasks)` };
  const missing = d.dependsOn.filter((dep) => !tasks.has(dep));
  if (missing.length) return { status: 400, error: `Unknown dependency: ${missing.join(", ")}` };
  if (d.images.some((id) => !uploads.exists(id))) return { status: 400, error: "Unknown picture: upload it with POST /api/uploads first" };
  if (d.audio.some((id) => !uploads.exists(id))) return { status: 400, error: "Unknown audio: upload it with POST /api/uploads first" };
  if (d.documents.some((id) => !uploads.exists(id))) return { status: 400, error: "Unknown PDF: upload it with POST /api/uploads first" };
  // Routine runs are forced read-only and get exactly one destination
  const routine = routineFields(d, { telegramChat: telegram ? [...TELEGRAM_ALLOWED][0] : undefined, vault: OBSIDIAN_VAULT || undefined });
  if ("error" in routine) return { status: 400, error: routine.error };
  const now = Date.now();
  const requested = d.targetAgent;
  const task: Task = {
    id,
    prompt: d.prompt,
    title: d.title || d.prompt.split("\n")[0].slice(0, 80),
    // Until the router runs, an "auto" task is shown as the planner's
    targetAgent: requested === "auto" ? "planner" : requested,
    requestedAgent: requested,
    routedBy: requested === "auto" ? undefined : "user",
    source: d.source,
    model: "",
    modelOverride: d.model,
    status: queueIt ? "queued" : "backlog",
    priority: d.priority,
    dependsOn: d.dependsOn,
    needsReview: d.needsReview,
    readOnly: routine.readOnly || undefined,
    deliverTo: routine.deliverTo,
    allowedSites: d.allowedSites.length ? d.allowedSites : undefined,
    images: d.images.length ? d.images : undefined,
    audio: d.audio.length ? d.audio : undefined,
    documents: d.documents.length ? d.documents : undefined,
    position: now,
    createdAt: now,
    queuedAt: queueIt ? now : undefined,
    events: [],
    chatId: extra.chatId ?? routine.chatId,
    routineId: d.source === "routine" ? extra.routineId : undefined,
  };

  // Model switches answer at once and show up as a finished card
  // A routine's prompt never changes model settings
  const switched = d.source !== "eval" && d.source !== "routine" ? handleSwitch(d.prompt) : null;
  if (switched) {
    task.status = "complete";
    task.answer = switched;
    task.finishedAt = now;
    store.add(task);
    emit(task, "queued", `> ${task.prompt}\n\n`);
    emit(task, "complete", switched);
    notifyDone(task);
    return { task, status: 202 };
  }

  store.add(task);
  emit(task, task.status, `> ${task.prompt}\n\n`);
  void pump();
  return { task, status: 202 };
}

function enqueue(input: unknown, res: Response) {
  const result = createTask(input);
  if (!result.task) return res.status(result.status).json({ error: result.error });
  // position 0 means it starts right away
  const position = runningTaskId === result.task.id || result.task.status === "complete" ? 0 : store.queuedCount();
  res.status(202).json({ taskId: result.task.id, position });
}

function cancel(taskId: string | undefined, res: Response) {
  const task = taskId ? tasks.get(taskId) : undefined;
  if (!task || TERMINAL_STATUSES.includes(task.status)) {
    return res.status(404).json({ error: "Task not found or already finished" });
  }
  if (task.status === "queued" || task.status === "backlog") {
    task.finishedAt = Date.now();
    emit(task, "canceled", "[Removed from queue]");
    notifyDone(task);
  } else {
    task.abortReason = "user";
    task.controller?.abort();
  }
  res.status(200).json({ status: "canceled", taskId: task.id });
}

function retry(task: Task): string | null {
  if (!TERMINAL_STATUSES.includes(task.status)) return "Only finished, failed or canceled cards can be retried";
  if (store.queuedCount() >= MAX_QUEUE) return `Queue is full (${MAX_QUEUE} tasks)`;
  for (const sub of store.children(task.id)) store.archiveOne(sub.id);
  Object.assign(task, {
    error: undefined,
    interrupted: undefined,
    answer: undefined,
    delegatedTo: undefined,
    acceptedAt: undefined,
    finishedAt: undefined,
    startedAt: undefined,
    queuedAt: Date.now(),
  });
  if (task.requestedAgent === "auto") task.routedBy = undefined;
  emit(task, "queued", `\n\n── Attempt ${(task.attempts ?? 0) + 1} ──\n\n`);
  void pump();
  return null;
}

/** Turns a card's answer into a PDF report and adds it to the card's files. */
async function makeReport(task: Task): Promise<{ name: string; pictures: number; missing: number } | { error: string }> {
  if (!BROWSER_CDP_URL) return { error: "PDFs are printed by the browser sidecar: set BROWSER_CDP_URL (see README-HQ)" };
  if (!task.answer?.trim()) return { error: "This card has no answer to turn into a PDF" };
  try {
    const report = await buildReport(task.answer, { title: task.title || task.prompt.slice(0, 80), author: "Mission Control" }, { uploads, allowPrivate: BROWSER_ALLOW_PRIVATE });
    for (const m of report.missing) hive.log(task.targetAgent, "pdf", `Picture skipped (${m.error}): ${m.src.slice(0, 120)}`, task.id);
    const saved = files.save(report.title, await printPdf(report.html, BROWSER_CDP_URL));
    task.files = [...(task.files ?? []).filter((f) => f.name !== saved.name), { ...saved, pictures: report.pictures, at: Date.now() }];
    store.save(task);
    return { name: saved.name, pictures: report.pictures, missing: report.missing.length };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Answers a finished card: the round so far joins its history and the card runs again on the reply. */
function replyTo(task: Task, input: unknown): string | null {
  const parsed = TaskReplySchema.safeParse(input);
  if (!parsed.success) return JSON.stringify(parsed.error.flatten());
  const r = parsed.data;
  if (!TERMINAL_STATUSES.includes(task.status)) return "Wait for the card to finish before replying";
  if (task.source === "eval") return "Eval runs can't be replied to";
  if (store.queuedCount() >= MAX_QUEUE) return `Queue is full (${MAX_QUEUE} tasks)`;
  if ([...r.images, ...r.audio, ...r.documents].some((id) => !uploads.exists(id))) return "Unknown attachment: upload it with POST /api/uploads first";
  const now = Date.now();
  task.thread = closeRound(task, now);
  task.reply = r.message;
  task.images = r.images.length ? r.images : undefined;
  task.audio = r.audio.length ? r.audio : undefined;
  task.documents = r.documents.length ? r.documents : undefined;
  task.privateNotes = undefined;
  if (r.targetAgent === "auto") {
    task.requestedAgent = "auto";
    task.routedBy = undefined;
  } else if (r.targetAgent !== "same") {
    task.requestedAgent = r.targetAgent;
    task.targetAgent = r.targetAgent;
    task.routedBy = "user";
  } else {
    // Keep talking to whoever answered
    task.requestedAgent = task.targetAgent;
  }
  Object.assign(task, {
    error: undefined,
    interrupted: undefined,
    answer: undefined,
    delegatedTo: undefined,
    acceptedAt: undefined,
    finishedAt: undefined,
    startedAt: undefined,
    queuedAt: now,
  });
  emit(task, "queued", `\n\n── You replied ──\n> ${r.message}\n\n`);
  void pump();
  return null;
}

function patchTask(task: Task, input: unknown): { error?: string } {
  const parsed = TaskPatchSchema.safeParse(input);
  if (!parsed.success) return { error: JSON.stringify(parsed.error.flatten()) };
  const p = parsed.data;
  const locked = routinePatchError(task, p);
  if (locked) return { error: locked };
  const editable = task.status === "backlog" || task.status === "queued";
  if (!editable && (p.prompt || p.targetAgent || p.dependsOn || p.column)) return { error: "Only cards in Backlog or Ready can be changed" };
  if (p.dependsOn) {
    if (p.dependsOn.includes(task.id)) return { error: "A card can't depend on itself" };
    const missing = p.dependsOn.filter((d) => !tasks.has(d));
    if (missing.length) return { error: `Unknown dependency: ${missing.join(", ")}` };
    // Refuse cycles: walk the dependency graph from each new dependency
    const seen = new Set<string>();
    const stack = [...p.dependsOn];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === task.id) return { error: "That would create a dependency loop" };
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(tasks.get(id)?.dependsOn ?? []));
    }
    task.dependsOn = p.dependsOn;
  }
  if (p.title !== undefined) task.title = p.title || task.prompt.split("\n")[0].slice(0, 80);
  if (p.prompt) task.prompt = p.prompt;
  if (p.priority) task.priority = p.priority;
  if (p.needsReview !== undefined) task.needsReview = p.needsReview;
  if (p.readOnly !== undefined) {
    if (!editable) return { error: "Only cards in Backlog or Ready can change read-only mode" };
    task.readOnly = p.readOnly || undefined;
  }
  if (p.allowedSites !== undefined) task.allowedSites = p.allowedSites.length ? p.allowedSites : undefined;
  if (p.documents !== undefined) {
    if (!editable) return { error: "Only cards in Backlog or Ready can change their PDFs" };
    if (p.documents.some((id) => !uploads.exists(id))) return { error: "Unknown PDF: upload it first" };
    task.documents = p.documents.length ? p.documents : undefined;
  }
  if (p.audio !== undefined) {
    if (!editable) return { error: "Only cards in Backlog or Ready can change their audio" };
    if (p.audio.some((id) => !uploads.exists(id))) return { error: "Unknown audio: upload it first" };
    task.audio = p.audio.length ? p.audio : undefined;
  }
  if (p.images !== undefined) {
    if (!editable) return { error: "Only cards in Backlog or Ready can change their pictures" };
    const missing = p.images.filter((id) => !uploads.exists(id));
    if (missing.length) return { error: "Unknown picture: upload it first" };
    task.images = p.images.length ? p.images : undefined;
  }
  if (p.position !== undefined) task.position = p.position;
  if (p.targetAgent) {
    task.requestedAgent = p.targetAgent;
    task.targetAgent = p.targetAgent === "auto" ? "planner" : p.targetAgent;
    task.routedBy = p.targetAgent === "auto" ? undefined : "user";
  }
  if (p.column && boardColumn(task) !== p.column) {
    if (p.column === "ready" && store.queuedCount() >= MAX_QUEUE) return { error: `Queue is full (${MAX_QUEUE} tasks)` };
    task.queuedAt = p.column === "ready" ? Date.now() : undefined;
    emit(task, p.column === "ready" ? "queued" : "backlog");
  }
  store.save(task);
  void pump();
  return {};
}

// --- Telegram ---------------------------------------------------------------
let telegram: TelegramBot | null = null;

/** Sends a finished routine run to its one destination. The card on the dashboard always has the result. */
function deliverRoutine(task: Task) {
  if (task.parentId) return;
  try {
    if (task.deliverTo === "telegram" && telegram && task.chatId) {
      telegram.send(task.chatId, deliveryText(task)).catch((e) => hive.log("telegram", "error", String(e)));
    } else if (task.deliverTo === "obsidian" && OBSIDIAN_VAULT && task.status === "complete" && task.answer) {
      saveRoutineNote(OBSIDIAN_VAULT, task.title || "routine", task.answer);
    }
  } catch (error) {
    hive.log("routine", "error", `delivery failed: ${error instanceof Error ? error.message : String(error)}`, task.id);
  }
}

function notifyDone(task: Task) {
  if (isRoutine(task)) {
    scheduler.finished(task);
    return deliverRoutine(task);
  }
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
      const active = [...tasks.values()].filter((t) => !t.parentId && !TERMINAL_STATUSES.includes(t.status) && t.status !== "backlog");
      return active.map((t) => `${t.id.slice(0, 8)} ${t.status} ${t.targetAgent}: ${t.title ?? t.prompt.slice(0, 60)}`).join("\n") || "Queue is empty.";
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
  res.status(200).json({ status: "ok", service: "ts-harness", port: PORT, model: models.resolve("planner").ref, ollama });
});

// GPU and queue state for the Mission Control system tile
app.get("/api/system", async (_req: Request, res: Response) => {
  const queueInfo = {
    running: runningTaskId,
    queued: store.queuedCount(),
    fastModel: models.resolve("router").ref,
    telegram: Boolean(telegram),
    obsidian: Boolean(OBSIDIAN_VAULT),
    browser: Boolean(BROWSER_CDP_URL),
    memories: memory.list().length,
    lastModel: lastModelRef,
    notices: notices.list().length,
  };
  const model = models.resolve("planner").ref;
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/ps`, { signal: AbortSignal.timeout(2000) });
    const ps = (await r.json()) as { models?: { name: string; size: number; size_vram: number }[] };
    const loaded = (ps.models ?? []).map((m) => ({
      name: m.name,
      sizeGB: Math.round((m.size / 1024 ** 3) * 10) / 10,
      vramPct: m.size > 0 ? Math.round((100 * m.size_vram) / m.size) : 0,
    }));
    res.json({ ollama: "up", url: OLLAMA_BASE_URL, model, models: loaded, ...queueInfo });
  } catch {
    res.json({ ollama: "down", url: OLLAMA_BASE_URL, model, models: [], ...queueInfo });
  }
});

app.get("/api/agent/stream", handleStream);
app.get("/api/browser/stream", handleBrowserStream);
app.post("/api/agent/run", requireToken, (req, res) => enqueue(req.body, res));
app.post("/api/agent/:id/cancel", requireToken, (req, res) => cancel(String(req.params.id), res));

app.get("/api/tasks", (_req: Request, res: Response) => {
  const list = [...tasks.values()].filter((t) => !t.parentId).sort((a, b) => b.createdAt - a.createdAt).map(summarize);
  res.json(list);
});

app.get("/api/tasks/:id", (req: Request, res: Response) => {
  const task = tasks.get(String(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });
  res.json({
    ...summarize(task),
    answer: task.answer,
    thread: task.thread,
    plannedModel: plannedModel(task),
    waitingOn: waitingOn(task, tasks),
    subtasks: store.children(task.id).map((s) => ({ ...summarize(s), answer: s.answer })),
    events: store.events(task.id),
  });
});

// --- Board ------------------------------------------------------------------
app.get("/api/board", (_req: Request, res: Response) => {
  const cards = [...tasks.values()]
    .filter((t) => !t.parentId)
    .map((t) => {
      const subs = store.children(t.id);
      return {
        ...summarize(t),
        column: boardColumn(t),
        plannedModel: t.model || plannedModel(t),
        waitingOn: waitingOn(t, tasks),
        subtasks: subs.map((s) => ({ id: s.id, title: s.title, targetAgent: s.targetAgent, status: s.status, model: s.model })),
        preview: (t.answer ?? t.error ?? "").slice(0, 160),
      };
    })
    .sort((a, b) => (a.position ?? a.createdAt) - (b.position ?? b.createdAt));
  res.json({ columns: ["backlog", "ready", "running", "review", "done", "failed"], cards, running: runningTaskId });
});

app.post("/api/tasks", requireToken, (req, res) => {
  const result = createTask({ source: "ui", ...req.body });
  if (!result.task) return res.status(result.status).json({ error: result.error });
  res.status(201).json(summarize(result.task));
});

app.patch("/api/tasks/:id", requireToken, (req, res) => {
  const task = tasks.get(String(req.params.id));
  if (!task || task.parentId) return res.status(404).json({ error: "Task not found" });
  const result = patchTask(task, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(summarize(task));
});

app.post("/api/tasks/:id/retry", requireToken, (req, res) => {
  const task = tasks.get(String(req.params.id));
  if (!task || task.parentId) return res.status(404).json({ error: "Task not found" });
  const err = retry(task);
  if (err) return res.status(400).json({ error: err });
  res.json(summarize(task));
});

app.post("/api/tasks/:id/reply", requireToken, (req, res) => {
  const task = tasks.get(String(req.params.id));
  if (!task || task.parentId) return res.status(404).json({ error: "Task not found" });
  const err = replyTo(task, req.body);
  if (err) return res.status(400).json({ error: err });
  res.json(summarize(task));
});

app.post("/api/tasks/:id/pdf", requireToken, async (req, res) => {
  const task = tasks.get(String(req.params.id));
  if (!task || task.parentId) return res.status(404).json({ error: "Task not found" });
  if (!TERMINAL_STATUSES.includes(task.status)) return res.status(400).json({ error: "Wait for the card to finish" });
  const made = await makeReport(task);
  if ("error" in made) return res.status(400).json(made);
  res.json({ ...made, url: `/api/files/${made.name}` });
});

app.get("/api/files/:name", (req, res) => {
  const name = String(req.params.name);
  const file = FILE_ID.test(name) ? files.read(name) : null;
  if (!file) return res.status(404).json({ error: "File not found" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(file.length));
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${name}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(file);
});

app.post("/api/tasks/:id/accept", requireToken, (req, res) => {
  const task = tasks.get(String(req.params.id));
  if (!task || task.status !== "complete") return res.status(400).json({ error: "Only finished cards can be accepted" });
  task.acceptedAt = Date.now();
  store.save(task);
  void pump(); // cards waiting on this one may now run
  res.json(summarize(task));
});

app.post("/api/tasks/:id/archive", requireToken, (req, res) => {
  const task = tasks.get(String(req.params.id));
  if (!task || task.parentId) return res.status(404).json({ error: "Task not found" });
  if (RUNNING_STATUSES.includes(task.status)) return res.status(400).json({ error: "Cancel the card before removing it" });
  store.archive(task.id);
  res.json({ ok: true });
});

// --- Models (Team page) -----------------------------------------------------
app.get("/api/models", (_req, res) => {
  const providers = models.providers().map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    local: p.local,
    baseUrl: p.baseUrl,
    apiKeyEnv: p.apiKeyEnv,
    keySet: p.apiKeyEnv ? Boolean(process.env[p.apiKeyEnv]) : null,
  }));
  const resolved = Object.fromEntries(MODEL_ROLES.map((r) => [r, models.resolve(r).ref]));
  res.json({
    settings: models.settings(),
    resolved,
    providers,
    usage: store.usageToday(),
    spendThisMonth: store.spendByAgentThisMonth(),
    spendTotalThisMonth: store.spendThisMonth(),
  });
});

app.get("/api/models/available", async (req, res) => {
  const p = models.providers().find((x) => x.id === String(req.query.provider ?? "ollama"));
  if (!p) return res.status(404).json({ error: "Unknown provider" });
  res.json({ provider: p.id, models: await listModels(p) });
});

app.get("/api/models/check", async (_req, res) => {
  const providers = models.providers();
  const results = await Promise.all(providers.map(async (p) => ({ id: p.id, ...(await checkProvider(p)) })));
  res.json(results);
});

app.put("/api/models", requireToken, (req, res) => {
  const err = models.update(req.body ?? {});
  if (err) return res.status(400).json({ error: err });
  hive.log("models", "updated", "Team model settings changed");
  void pump();
  res.json({ settings: models.settings() });
});

// Notices: budget hits, local-only redirects, missing prices
app.get("/api/notices", (_req, res) => res.json(notices.list()));
app.post("/api/notices/dismiss", requireToken, (req, res) => {
  notices.dismiss(typeof req.body?.id === "string" ? req.body.id : undefined);
  res.json({ ok: true });
});

// Team, hive mind and memory
app.get("/api/agents", (_req, res) => {
  res.json(
    AGENT_KEYS.map((k) => ({ key: k, name: TEAM[k].name, role: TEAM[k].role, canDelegate: k === "planner", model: models.resolve(k).ref })),
  );
});
app.get("/api/hive", (req, res) => {
  res.json(hive.recent(Math.min(Number(req.query.limit) || 100, 500)));
});
app.get("/api/memories", (_req, res) => res.json(memory.list()));
// Pictures for cards: upload as base64 (a data: URL is fine), then pass the id in "images"
app.post("/api/uploads", requireToken, async (req, res) => {
  const data = typeof req.body?.data === "string" ? req.body.data : "";
  // Audio is sent as WAV; the dashboard converts recordings before uploading
  const kind =
    req.body?.kind === "pdf" || /^data:application\/pdf/.test(data) ? "pdf" : req.body?.kind === "audio" || /^data:audio\//.test(data) ? "audio" : "image";
  const out = uploads.save(data, kind);
  if ("error" in out) return res.status(400).json({ error: out.error });
  if (kind !== "pdf") return res.status(201).json(out);
  // PDFs are read once, here, so a broken or locked file is caught before it's attached
  try {
    const name = cleanName(req.body?.name);
    const doc = { ...(docCache.get(out.id) ?? (await extractPdf(uploads.bytes(out.id)!, name))), name };
    docCache.set(out.id, doc);
    res.status(201).json({ ...out, name, pages: doc.totalPages, scanned: doc.scanned, title: doc.title });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
app.get("/api/uploads/:id/info", (req, res) => {
  const doc = docCache.get(String(req.params.id));
  if (!doc) return res.status(404).json({ error: "PDF not found" });
  res.json({ id: req.params.id, name: doc.name, pages: doc.totalPages, scanned: doc.scanned, title: doc.title });
});
app.get("/api/uploads/:id", (req, res) => {
  const img = uploads.read(String(req.params.id));
  if (!img) return res.status(404).json({ error: "Picture not found" });
  res.setHeader("Content-Type", img.type);
  res.setHeader("Content-Length", String(img.buf.length));
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // PDFs open in the browser's own viewer, which a strict policy would block
  if (img.type === "application/pdf") res.setHeader("Content-Disposition", "inline");
  else res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.end(img.buf);
});

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

// --- Routines (scheduled read-only cards) ------------------------------------
const ROUTINE_TZ = process.env.ROUTINE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const ROUTINE_MIN_MINUTES = Math.max(1, Number(process.env.ROUTINE_MIN_MINUTES) || 5);
const routineEnv = () => ({ telegramChat: telegram ? [...TELEGRAM_ALLOWED][0] : undefined, vault: OBSIDIAN_VAULT || undefined });
const scheduler = new Scheduler(
  store,
  {
    start: (r) => {
      const out = createTask(
        { prompt: r.prompt, title: r.name, targetAgent: r.targetAgent, source: "routine", deliverTo: r.deliverTo, allowedSites: r.allowedSites, column: "ready" },
        { routineId: r.id },
      );
      if (!out.task) return { error: typeof out.error === "string" ? out.error : "the card couldn't be created" };
      hive.log("routine", "started", `${r.name} (${r.label})`, out.task.id);
      return { taskId: out.task.id };
    },
    busy: (id) => {
      const t = tasks.get(id);
      return Boolean(t && !TERMINAL_STATUSES.includes(t.status));
    },
    checkDelivery: (r) => {
      const f = routineFields({ source: "routine", deliverTo: r.deliverTo }, routineEnv());
      return "error" in f ? f.error : null;
    },
    note: (r, message) => {
      notices.add("routine", `routine:${r.id}`, message);
      hive.log("routine", "skipped", message);
    },
  },
  { defaultTimezone: ROUTINE_TZ, minMinutes: ROUTINE_MIN_MINUTES },
);

const routineView = (r: ReturnType<Scheduler["list"]>[number]) => ({
  ...r,
  upcoming: r.enabled ? upcoming(r.cron, Date.now(), r.timezone, 3) : [],
  lastTask: r.lastTaskId && tasks.has(r.lastTaskId) ? { id: r.lastTaskId, status: tasks.get(r.lastTaskId)!.status } : undefined,
});

app.get("/api/routines", (_req, res) => {
  res.json({ routines: scheduler.list().map(routineView), timezone: ROUTINE_TZ, minMinutes: ROUTINE_MIN_MINUTES, deliveries: { telegram: Boolean(routineEnv().telegramChat), obsidian: Boolean(routineEnv().vault) } });
});
// Checks a schedule as it's typed: its label and next three times
app.post("/api/routines/preview", (req, res) => {
  const tz = typeof req.body?.timezone === "string" && validTimeZone(req.body.timezone) ? req.body.timezone : ROUTINE_TZ;
  try {
    const p = parseSchedule(String(req.body?.schedule ?? ""));
    res.json({ ...p, timezone: tz, upcoming: upcoming(p.cron, Date.now(), tz, 3) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
app.post("/api/routines", requireToken, (req, res) => {
  const out = scheduler.create(req.body);
  if ("error" in out) return res.status(400).json(out);
  hive.log("routine", "created", `${out.name}: ${out.label}`);
  res.status(201).json(routineView(out));
});
app.patch("/api/routines/:id", requireToken, (req, res) => {
  const out = scheduler.update(String(req.params.id), req.body);
  if ("error" in out) return res.status(out.error === "Routine not found" ? 404 : 400).json(out);
  res.json(routineView(out));
});
app.delete("/api/routines/:id", requireToken, (req, res) => {
  if (!scheduler.remove(String(req.params.id))) return res.status(404).json({ error: "Routine not found" });
  res.json({ ok: true });
});
app.post("/api/routines/:id/run", requireToken, (req, res) => {
  const out = scheduler.runNow(String(req.params.id));
  if ("error" in out) return res.status(out.error === "Routine not found" ? 404 : 409).json({ error: `Didn't run: ${out.error}` });
  res.status(201).json(out);
});
app.get("/api/routines/:id/runs", (req, res) => {
  const id = String(req.params.id);
  const runs = [...tasks.values()]
    .filter((t) => t.routineId === id && !t.parentId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map((t) => ({ id: t.id, status: t.status, createdAt: t.createdAt, finishedAt: t.finishedAt, preview: (t.answer ?? t.error ?? "").slice(0, 200), files: t.files }));
  res.json(runs);
});

app.listen(PORT, HOST, () => {
  console.log(`ts-harness listening on http://${HOST}:${PORT}`);
  console.log(`Ollama: ${OLLAMA_BASE_URL}  Jarvis: ${models.resolve("planner").ref}  router: ${models.resolve("router").ref}`);
  console.log(`Data: ${DATA_DIR}  Obsidian: ${OBSIDIAN_VAULT || "off"}  Telegram: ${telegram ? "on" : "off"}  Browser: ${BROWSER_CDP_URL || "off"}`);
  if (recovered) console.log(`Recovered ${recovered} task(s) interrupted by the last shutdown; they wait for Retry.`);
  // Cards that were queued before the restart pick up where they left off
  void pump();
  scheduler.start();
  const active = scheduler.list().filter((r) => r.enabled).length;
  console.log(`Routines: ${active} active (time zone ${ROUTINE_TZ})`);
});
