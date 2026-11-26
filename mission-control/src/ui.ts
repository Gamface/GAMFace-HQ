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
  PlanReviewSchema,
  QuestionAnswerSchema,
  TaskPatchSchema,
  TaskReplySchema,
  TaskSummary,
  TERMINAL_STATUSES,
  boardColumn,
} from "./schemas/agent";
import { BrowserSession, Frame, SEARCH_SITES } from "./hq/browser";
import { runBrowserAgent } from "./hq/browser-agent";
import { runToolAgent } from "./hq/tool-agent";
import { studioTools, writeLyrics } from "./hq/studio-tools";
import { StreamGuard, redact } from "./hq/guard";
import { Hive } from "./hq/hive";
import { Memory } from "./hq/memory";
import { startBrain, type Brain } from "./brain";
import { brainEnabled } from "./brain/db";
import { ModelGateway } from "./hq/gateway";
import type { CallOptions } from "./hq/gateway";
import { deliveryText, hiveSummary, isRoutine, routineFields, routinePatchError, saveRoutineNote } from "./hq/routine";
import { MODEL_ROLES, ModelRegistry, ModelRole, parsePresetCommand, parseSwitchCommand, resolveTarget } from "./hq/models";
import { Notices } from "./hq/notices";
import type { ChatMessage, JsonChat } from "./hq/ollama";
import { checkProvider, listModels } from "./hq/providers";
import { RUNNING_STATUSES, Task, TaskStore, pickNext, waitingOn } from "./hq/taskstore";
import {
  AGENT_KEYS,
  delegationRules,
  setToolsSummary,
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
import { carriedPrivate, hasPrivate, privateBlock, resolvePrivate, sanitize, splitPrivate } from "./hq/privacy";
import { Uploads } from "./hq/uploads";
import { parseWav, splitWav } from "./hq/wav";
import { closeRound, historyMessages } from "./hq/thread";
import { FILE_ID, Files, buildReport, fileType, pdfInstructions, printPdf, wantsPdf } from "./hq/pdf";
import { BookStore, TRIMS, addSource, bookDetail, bookEpub, bookFileName, bookHtml, bookMarkdown, bookSummary, describeStep, editBook, failed, newBook, nextStep, removeSource, rewriteChapter, runStep, settle, trimOf } from "./hq/books";
import type { Book, BookModel, BookStep, ImageLoader, Trim } from "./hq/books";
import { MIN_PAGES, MAX_PAGES, coverHtml, coverSpec, gutterFor } from "./hq/kdp";
import type { Paper } from "./hq/kdp";
import { docxToText, fetchSource } from "./hq/sources";
import { COMPETITION_CHECKS, ResearchStore, competitionOf, conceptsPrompt, etsyKeyHeader, isBlockedPage, mineEtsy, mineKeywords, newResearch, parseConcepts, parseResults, renderPage, scoreKeywords, searchUrl } from "./hq/research";
import type { Research } from "./hq/research";
import type { SourceKind } from "./hq/sources";
import { DOC_ID, DocCache, cleanName, extractPdf, partsOf, pdfPageCount, withPageMarks } from "./hq/docs";
import type { PdfText } from "./hq/docs";
import { Scheduler } from "./hq/scheduler";
import { ApprovalCenter, ApprovalPolicySchema } from "./hq/approvals";
import { ASK_RULES, QuestionStore, answerMessage, parseAsks, readyToDeliver } from "./hq/inbox";
import { PLAN_RULES, cleanAnnotations, applyAnnotations, reviewMessage } from "./hq/plans";
import type { ActionRequest, Approval } from "./hq/approvals";
import { PROFILE_NAME, Profiles } from "./hq/profiles";
import { BrowserControl } from "./hq/takeover";
import { HistoryIndex, SKILL_DRAFT_SYSTEM, Skills, skillDraftPrompt } from "./hq/skills";
import type { Skill } from "./hq/skills";
import { VIDEO_MAX_SECONDS, VideoClient, extractScene, videoInstructions, wantsVertical, wantsVideo } from "./hq/video";
import type { SceneSpec } from "./hq/video";
import { ToolsClient, isDestructive, refuseFromHost, toolsFor, type ToolMedia } from "./hq/tools";
import { KNOWN_VOICES, VoiceClient, extractNarration, sceneVoice, wantsCaptions, wantsOwnAudio, wantsVoice } from "./hq/voice";
import type { Word } from "./hq/voice";
import { AssetInputSchema, AssetPatchSchema, AssetUploadSchema, Assets, SYSTEM_FONTS, assetBlock, publicName } from "./hq/assets";
import { galleryItems, galleryKind } from "./hq/gallery";
import { Projects, projectPrompt, projectScope, visibleIn } from "./hq/projects";
import { Changes, rootLabel } from "./hq/changes";
import type { Root } from "./hq/changes";
import { Workspace, extractFileOps, namedWorkspace, workspaceBlock } from "./hq/workspace";
import type { PinnedElement } from "./hq/browser";
import { readFileSync as readFileSyncFs, readdirSync as readdirSyncFs, statSync as statSyncFs } from "node:fs";
import type { Asset, Brand } from "./hq/assets";
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
// Who turns recordings into text: "whisper" (the voice service's faster-whisper on the
// CPU, like Jarvis's wake word; the default when VOICE_URL is set) or "model" (the
// Transcriber on the Team page). If Whisper fails, the Transcriber is used instead.
const TRANSCRIBE_WITH = (process.env.TRANSCRIBE_WITH || "whisper").toLowerCase() === "model" ? "model" : "whisper";
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
// The folders the Coder and File agents may edit, one per project ("general" for General)
const WORKSPACES_DIR = path.resolve(process.env.WORKSPACES_DIR || path.join(DATA_DIR, "workspaces"));
// How much of the workspace's file contents goes into a request (fits an 8K context)
const WORKSPACE_CONTEXT_CHARS = Number(process.env.WORKSPACE_CONTEXT_CHARS ?? 12_000);
const MEMORY_INTERVAL_MIN = Number(process.env.MEMORY_INTERVAL_MIN) || 30;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);
// Real browsing: a Chrome DevTools endpoint, e.g. http://browser:9222 (docker-compose.yml)
const BROWSER_CDP_URL = process.env.BROWSER_CDP_URL || "";
const BROWSER_MAX_STEPS = Number(process.env.BROWSER_MAX_STEPS) || 10;
// Tool calls the Tools agent may make on one card
const TOOLS_MAX_STEPS = Number(process.env.TOOLS_MAX_STEPS) || 6;
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
// Questions agents leave for you in the Inbox (beside the cards, in the same database)
const questions = new QuestionStore(store.sql);
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
// Videos: the Remotion service (video/, docker-compose.yml)
const VIDEO_RENDER_URL = process.env.VIDEO_RENDER_URL || "";
const video = VIDEO_RENDER_URL ? new VideoClient(VIDEO_RENDER_URL.replace(/\/+$/, "")) : null;
// How many times the Coder may fix a scene that fails to render
const VIDEO_FIX_ROUNDS = Number(process.env.VIDEO_FIX_ROUNDS ?? 2);
// Voiceovers and word timings: the voice service (voice/, docker-compose.yml)
const VOICE_URL = process.env.VOICE_URL || "";
// The music studio (studio/, docker-compose.yml): songs, stems, practice, karaoke, sheet music
const STUDIO_URL = (process.env.STUDIO_URL || "").replace(/\/+$/, "");
const voice = VOICE_URL ? new VoiceClient(VOICE_URL.replace(/\/+$/, "")) : null;
// Tools (MCP servers) for the agents: the tools service (tools/, docker-compose.yml)
const TOOLS_URL = process.env.TOOLS_URL || "";
// The music studio's own tools for Jarvis (find and add tracks, lyrics, vocals, songs) run here
const tools =
  TOOLS_URL || STUDIO_URL
    ? new ToolsClient(TOOLS_URL.replace(/\/+$/, ""), STUDIO_URL ? [studioTools({ studio: studioFetch, chat: roleJson("planner") })] : [])
    : null;
// Logos, pictures, clips, music and fonts the Coder may use, and the brand
const assets = new Assets(DATA_DIR);
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

// --- Approvals (Phase 4) -------------------------------------------------------
// Typing, submitting and button clicks wait for the user's answer (approvals.ts)

/** One line saying what an agent wants to do. */
function describeAction(a: Pick<Approval, "kind" | "target" | "text" | "site" | "detail">): string {
  const text = a.text ? `“${a.text.length > 120 ? `${a.text.slice(0, 120)}…` : a.text}”` : "";
  switch (a.kind) {
    case "search":
      return text ? `search for ${text} on ${a.site}` : `run the search “${a.target}” on ${a.site}`;
    case "type":
      return `type ${text} into “${a.target}” on ${a.site}`;
    case "submit":
      return text ? `type ${text} into “${a.target}” and submit it on ${a.site}` : `submit “${a.target}” on ${a.site}`;
    case "tool":
      return `send ${text || "a request"} to the tool ${a.target} (${a.detail ?? "its instructions came from your private notes or memories"})`;
    case "change":
      return `use ${a.target}, which changes things, with ${text || "no arguments"}${a.detail ? ` (${a.detail})` : ""}`;
    default:
      return `click “${a.target}” on ${a.site}`;
  }
}

// Pausing a card's time limit while it waits for an answer
const taskTimers = new Map<string, { pause: () => void; resume: () => void }>();

const approvals = new ApprovalCenter({
  onRequest: (a) => {
    const t = tasks.get(a.taskId);
    if (t) {
      t.awaitingApproval = a.id;
      emit(
        t,
        "executing_tool",
        `\n⏸ Waiting for your approval to ${describeAction(a)}${a.risk === "high" ? " (high risk)" : ""}. ` +
          `Answer on the dashboard${telegram ? " or in Telegram" : ""} within ${approvals.policy.timeoutMinutes} minutes.\n`,
      );
    }
    hive.log(a.agent, "approval", `waiting: ${describeAction(a)}`, a.taskId);
    notifyApproval(a);
  },
  onDecision: (a) => {
    store.logApproval(a);
    const t = tasks.get(a.taskId);
    if (t && t.awaitingApproval === a.id) {
      t.awaitingApproval = undefined;
      const line =
        a.status === "approved"
          ? `✓ Approved${a.scope === "card" ? ` (and the rest of this card's ${a.kind === "click" ? "clicks" : "typing"} on ${a.site})` : ""}`
          : a.status === "expired"
            ? "✗ No answer in time, so it wasn't done"
            : a.status === "denied"
              ? `✗ Declined${a.note ? `: ${a.note}` : ""}`
              : "✗ Canceled";
      emit(t, "executing_tool", `${line}\n`);
    }
    if (a.decidedBy !== "policy" && a.decidedBy !== "card-grant") hive.log(a.agent, "approval", `${a.status}: ${describeAction(a)}`, a.taskId);
  },
});
approvals.policy = ApprovalPolicySchema.parse(store.getSetting("approvalPolicy", {}));

/** Asks before an action, with the card's time limit paused while it waits. */
async function askApproval(task: Task, agent: string, req: ActionRequest, signal: AbortSignal): Promise<string | null> {
  const timers = taskTimers.get(task.id);
  timers?.pause();
  try {
    return await approvals.check(req, { taskId: task.id, taskTitle: task.title || task.prompt, agent, unattended: isRoutine(task), signal });
  } finally {
    timers?.resume();
  }
}

// --- Browser profiles and taking over (Phase 5) --------------------------------
const profiles = new Profiles(path.join(DATA_DIR, "profiles"));
const defaultProfile = () => {
  const name = store.getSetting<string>("defaultProfile", "main");
  if (!profiles.exists(name)) profiles.create(name);
  return name;
};
defaultProfile();
// How long you can keep a browser before it goes back to the agent (or a profile window closes)
const TAKEOVER_TIMEOUT_MS = (Number(process.env.TAKEOVER_TIMEOUT_MIN) || 30) * 60_000;

interface LiveBrowser {
  id: string; // the card's id, or manual-<profile>
  taskId?: string;
  title: string;
  profile?: string;
  readOnly: boolean;
  manual: boolean;
  session: BrowserSession;
  control: BrowserControl;
  lastInputAt: number;
  // Annotate: what the user pinned on the page, and notes waiting for the agent's next step
  pins?: Map<number, PinnedElement & { url: string }>;
  nextPin?: number;
  notes?: string[];
}
const liveBrowsers = new Map<string, LiveBrowser>();

/** A pinned element in a sentence, for the agent (page text is untrusted, so it's cleaned and short). */
function describePin(n: number, el: PinnedElement): string {
  const what = el.type ? `${el.type} field` : el.role || ({ a: "link", img: "picture", button: "button", h1: "heading", h2: "heading", h3: "heading", li: "list item", td: "table cell", p: "paragraph", input: "field" } as Record<string, string>)[el.tag] || el.tag;
  const words = sanitize((el.text || el.label || "").slice(0, 160));
  return `#${n}: ${what}${words ? ` “${words}”` : ""}${el.href ? ` (links to ${el.href.slice(0, 200)})` : ""}${el.src ? ` (picture ${el.src.slice(0, 200)})` : ""} [${el.selector.slice(0, 120)}]`;
}

function controlEvent(lb: Pick<LiveBrowser, "id" | "profile" | "manual" | "readOnly">, c: BrowserControl) {
  broadcastBrowser({ type: "control", taskId: lb.id, state: c.state, by: c.requestedBy, reason: c.reason, profile: lb.profile, manual: lb.manual, readOnly: lb.readOnly });
}

/** A profile's sign-ins for a session, or null (with why) when they can't be used. */
function profileFor(name: string): { cookies: import("./hq/profiles").StoredCookie[]; save: (c: import("./hq/profiles").StoredCookie[]) => void } | { error: string } {
  if (!profiles.exists(name)) return { error: `there's no browser profile called “${name}”` };
  try {
    return { cookies: profiles.cookies(name), save: (c) => profiles.save(name, c) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Waits while the user has the browser, with the card's time limit paused. Returns a note for the agent. */
async function waitForUser(task: Task, control: BrowserControl, lb: LiveBrowser, signal: AbortSignal, push: (t: string) => void): Promise<string> {
  const timers = taskTimers.get(task.id);
  timers?.pause();
  push(`\n⏸ You have the browser${control.reason ? ` (${control.reason})` : ""}. The agent waits until you hand it back (at most ${TAKEOVER_TIMEOUT_MS / 60000} minutes).\n`);
  try {
    const how = await control.waitForAgent(signal, TAKEOVER_TIMEOUT_MS);
    if (how === "aborted") throw new Error("aborted");
    await lb.session.saveProfile().catch(() => {});
    push(how === "timeout" ? "▶ The browser went back to the agent (time's up)\n" : "▶ Back to the agent\n");
    return how === "timeout"
      ? `The user didn't hand the browser back within ${TAKEOVER_TIMEOUT_MS / 60000} minutes, so it came back automatically. Look at the page again before acting.`
      : "The user took over the browser and handed it back. Look at the page again before acting.";
  } finally {
    timers?.resume();
  }
}

/** Tells the user an agent needs them in its browser. */
function notifyHandoff(task: Task, reason: string) {
  hive.log("browser", "handoff", reason, task.id);
  if (!telegram) return;
  const chat = task.chatId ?? [...TELEGRAM_ALLOWED][0];
  if (chat) telegram.send(chat, `🙋 Jarvis Browser needs you: ${reason}\nCard: ${task.title || task.prompt.slice(0, 80)}\nOpen the dashboard's Browser tab and press Take over.`).catch(() => {});
}

/** Opens a profile in a browser you drive yourself, e.g. to sign in to sites ahead of time. */
async function openProfileWindow(name: string, url?: string): Promise<LiveBrowser | { error: string }> {
  if (!BROWSER_CDP_URL) return { error: "No browser is set up (BROWSER_CDP_URL)" };
  const id = `manual-${name}`;
  const open = liveBrowsers.get(id);
  if (open) return open;
  const profile = profileFor(name);
  if ("error" in profile) return profile;
  if ([...liveBrowsers.values()].some((b) => b.profile === name)) return { error: `“${name}” is in use by a running card; wait for it to finish` };
  const session = new BrowserSession({
    allowPrivate: BROWSER_ALLOW_PRIVATE,
    profile,
    onFrame: (f: Frame) => broadcastBrowser({ type: "frame", taskId: id, ...f }),
    onBlocked: (u, reason) => broadcastBrowser({ type: "blocked", taskId: id, url: u, reason }),
  });
  await session.start(BROWSER_CDP_URL);
  const lb: LiveBrowser = { id, title: `Profile “${name}”`, profile: name, readOnly: false, manual: true, session, control: new BrowserControl(), lastInputAt: Date.now() };
  lb.control = new BrowserControl((c) => controlEvent(lb, c));
  liveBrowsers.set(id, lb);
  broadcastBrowser({ type: "start", taskId: id, task: `Profile “${name}”: you're at the controls. Sign in where you need to, then Close & save.` });
  lb.control.takeOver("user", "your profile window");
  if (url) await session.navigate(url).catch((e) => broadcastBrowser({ type: "action", taskId: id, kind: "error", line: String(e instanceof Error ? e.message : e) }));
  hive.log("browser", "profile", `opened “${name}” for signing in`);
  return lb;
}

async function closeProfileWindow(lb: LiveBrowser) {
  liveBrowsers.delete(lb.id);
  await lb.session.close();
  broadcastBrowser({ type: "end", taskId: lb.id });
  hive.log("browser", "profile", `closed and saved “${lb.profile}”`);
}

// Profile windows close (and save) after a while without input
setInterval(() => {
  for (const lb of liveBrowsers.values()) if (lb.manual && Date.now() - lb.lastInputAt > TAKEOVER_TIMEOUT_MS) void closeProfileWindow(lb);
}, 60_000).unref();

/** Sends a waiting request to Telegram, with buttons. */
function notifyApproval(a: Approval) {
  if (!telegram) return;
  const t = tasks.get(a.taskId);
  const chat = t?.chatId ?? [...TELEGRAM_ALLOWED][0];
  if (!chat) return;
  const text =
    `⏸ ${TEAM[a.agent as AgentTarget]?.name ?? a.agent} wants to ${describeAction(a)}${a.risk === "high" ? " ⚠ HIGH RISK" : ""}\n` +
    `Card: ${a.taskTitle}\nPage: ${a.url}\n\nAnswer within ${approvals.policy.timeoutMinutes} min, or /approve ${a.code} · /deny ${a.code}`;
  telegram.sendApproval(chat, text, a.code, a.risk === "normal").catch((e) => hive.log("telegram", "error", String(e)));
}
// Every model request goes through the gateway: local-only lock, spend caps, private-context rule
const gateway = new ModelGateway(models, store, notices, OLLAMA_KEEP_ALIVE);
gateway.onServed = (ref) => {
  lastModelRef = ref;
};
const tasks = store.tasks;
// Separate workspaces: instructions, memories, skills, assets, sign-ins, routines
const projects = new Projects(DATA_DIR);
// Activity about a card is only shown inside the card's project
hive.projectOf = (taskId) => {
  const t = tasks.get(taskId);
  return t ? (t.project ?? null) : undefined;
};
/** The workspace a project's agents edit. */
function workspaceOf(project: string | null | undefined): Workspace {
  const p = projects.get(project);
  return namedWorkspace(p?.workspace || p?.id || "general", WORKSPACES_DIR);
}
// Every file an agent writes is recorded, so it can be looked at and undone
const changes = new Changes(store.sql, DATA_DIR, (root: Root) => {
  if (root.kind === "vault") return OBSIDIAN_VAULT ? new Workspace("vault", OBSIDIAN_VAULT) : null;
  try {
    const ws = namedWorkspace(root.name, WORKSPACES_DIR);
    ws.ensure();
    return ws;
  } catch {
    return null;
  }
});
/** Records notes saved to the vault, so they can be undone. */
function recordVault(task: Task, label: string, files: string[]) {
  if (!OBSIDIAN_VAULT || !files.length) return;
  const set = changes.recordCreated(
    { taskId: task.id, project: projects.idOf(task.project), label, root: { kind: "vault" } },
    files.map((f) => ({ path: path.relative(OBSIDIAN_VAULT, f).split(path.sep).join("/"), text: readFileSyncFs(f, "utf8") })),
  );
  if (set) {
    task.changes = [...(task.changes ?? []), set.id];
    store.save(task);
  }
}
/** Runs fn with the card's project as the scope of every model call (local-only projects stay local). */
const inProject = <T>(project: string | null | undefined, fn: () => Promise<T>) => projectScope.run(projects.scope(project), fn);

let runningTaskId: string | null = null;
let lastModelRef: string | null = null;
// Memory extraction runs between tasks so it never competes with one for the GPU
const memoryJobs: { agent: AgentTarget; prompt: string; answer: string; private: boolean; taskId: string; project: string | null }[] = [];

// --- Skills and history search (Phase 6) -----------------------------------------
const skills = new Skills(store.sql);
const historyIndex = new HistoryIndex(store.sql);
// Index cards from before history search existed
if (historyIndex.count() === 0) for (const t of store.tasks.values()) if (!t.parentId) historyIndex.put(t);
// Finished cards waiting for a skill draft (run when nothing else is queued)
const skillJobs: string[] = [];
const autoSkills = () => store.getSetting<boolean>("autoSkills", true);

/** Skills as instructions for an agent. Private ones are withheld from cloud models. */
function skillBlock(list: Skill[]): string {
  if (!list.length) return "";
  return (
    "\n\nSKILLS (procedures that worked before; follow them when they fit this request, and adapt them when they don't quite):\n" +
    list.map((s) => (s.private ? privateBlock(`### ${s.name}\n${s.steps}`, `(The skill “${s.name}” is private and stays on the user's PC.)`) : `### ${s.name}\n${s.steps}`)).join("\n\n")
  );
}

/** Whether a finished card is worth a skill draft: teamwork, real browsing or a back-and-forth. */
function worthASkill(task: Task): boolean {
  if (task.source === "eval" || task.source === "voice" || isRoutine(task) || task.readOnly || !task.answer) return false;
  const browserSteps = (task.events ?? []).reduce((n, e) => n + (e.logChunk.match(/🌐 /g)?.length ?? 0), 0);
  return (task.delegatedTo?.length ?? 0) >= 1 || browserSteps >= 4 || (task.thread?.length ?? 0) >= 2;
}

/** Asks a local model for a skill from a finished card. Returns the draft, or why there isn't one. */
async function draftSkill(task: Task): Promise<Skill | { error: string }> {
  if (!task.answer) return { error: "This card has no answer to learn from" };
  const steps = (task.events ?? [])
    .flatMap((e) => e.logChunk.split("\n"))
    .filter((l) => l.startsWith("🌐 ") || l.startsWith("── "))
    .join("\n");
  const priv = Boolean(task.usedPrivate);
  const content = skillDraftPrompt({
    request: task.thread?.length ? `${task.prompt}\n(then: ${task.reply ?? ""})` : task.prompt,
    agents: [task.targetAgent, ...(task.delegatedTo ?? [])],
    answer: priv ? privateBlock(task.answer, "(The result used private material and is withheld.)") : task.answer,
    steps,
  });
  const out = (await roleJson("memory", { privateTask: priv })("memory", [
    { role: "system", content: SKILL_DRAFT_SYSTEM },
    { role: "user", content },
  ])) as { skill?: unknown };
  if (!out.skill || typeof out.skill !== "object") return { error: "The model found no reusable procedure in this card" };
  const made = skills.create(out.skill, { status: "draft", private: priv, sourceTaskId: task.id, sourceTitle: task.title || task.prompt, project: projects.idOf(task.project) });
  if ("error" in made) return { error: `The draft wasn't usable (${made.error})` };
  hive.log("skills", "drafted", `${made.name}${made.replaces ? " (update)" : ""}`, task.id);
  notices.add("skill", `skill:${made.id}`, `New skill draft “${made.name}” from “${made.sourceTitle}”: review it on the Skills page.`);
  return made;
}
let backgroundBusy = false;
// Ids keep increasing across restarts, so a reconnecting UI never mistakes
// new events for ones it already has
let nextEventId = Math.max(Date.now(), store.maxEventId() + 1);

const app = express();
// The tools container may reach the harness's network, but never its API
if (TOOLS_URL) app.use(refuseFromHost(new URL(TOOLS_URL).hostname));
app.use(cors({ origin: CORS_ORIGINS }));
// Room for a 25 MB PDF or audio clip (or a 10 MB picture) sent as base64; asset
// uploads (clips up to 80 MB) get more
type Middleware = (req: Request, res: Response, next: NextFunction) => void;
const jsonBody = express.json({ limit: "40mb" }) as Middleware;
const assetBody = express.json({ limit: "120mb" }) as Middleware;
// Songs added to the studio: up to 100 MB of audio; clips for its videos: up to 200 MB (base64)
const studioBody = express.json({ limit: "140mb" }) as Middleware;
const studioMediaBody = express.json({ limit: "285mb" }) as Middleware;
app.use((req: Request, res: Response, next: NextFunction) => {
  const p = (req.url ?? "").split("?")[0];
  const parser =
    req.method !== "POST" ? jsonBody : p === "/api/assets" ? assetBody : p === "/api/studio/songs" ? studioBody : p === "/api/studio/media" ? studioMediaBody : jsonBody;
  return parser(req, res, next);
});

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

// Memory starts in data/memories.json; when the brain is configured (DATABASE_URL) it
// moves to the shared Postgres store at startup, before any task runs.
const memory = new Memory(DATA_DIR, roleJson("memory"), "memory");
let brain: Brain | null = null;
const CANON_SYNC_MIN = Number(process.env.CANON_SYNC_MIN) || 5;

/** The model a queued task will run on, for grouping same-model work (null when auto-routed). */
function plannedModel(t: Task): string | null {
  if (t.modelOverride) return models.resolve(t.targetAgent, t.modelOverride).ref;
  if (t.requestedAgent === "auto") return null;
  // A project's preset decides its cards' models
  return projectScope.run(projects.scope(t.project), () => models.resolve(t.targetAgent).ref);
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
  | { type: "blocked"; taskId: string; url: string; reason: string }
  | { type: "control"; taskId: string; state: "agent" | "user"; by?: "user" | "agent"; reason?: string; profile?: string; manual?: boolean; readOnly?: boolean };
const browserClients = new Set<Response>();
let lastFrame: BrowserEvent | null = null;
let lastFrameSentAt = 0;
const browserLog: BrowserEvent[] = [];

let trailingFrame: NodeJS.Timeout | null = null;

function broadcastBrowser(event: BrowserEvent) {
  if (event.type === "frame") {
    lastFrame = event;
    const now = Date.now();
    if (now - lastFrameSentAt < 200) {
      // Too soon: send the newest frame when the gap is up, so the view never stays stale
      trailingFrame ??= setTimeout(() => {
        trailingFrame = null;
        if (lastFrame) broadcastBrowser(lastFrame);
      }, 200 - (now - lastFrameSentAt));
      return;
    }
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

/** A plan-first card whose plan isn't approved yet: this run writes (or rewrites) the plan. */
const planMode = (task: Task) => Boolean(task.planFirst) && task.plan?.status !== "approved";
/** Cards whose lead may leave a question in the Inbox (someone is there to answer it). */
const mayAsk = (task: Task) => !isRoutine(task) && task.source !== "eval" && task.source !== "voice";

function systemPrompt(task: Task, agent: AgentTarget, opts: { team: boolean; delegate: boolean }) {
  let system = TEAM[agent].prompt;
  if (task.source === "voice") system += ` ${VOICE_STYLE}`;
  if (opts.delegate) system += delegationRules();
  // Only the lead's answer reaches you, so only the lead writes plans and asks questions
  if (agent === task.targetAgent && planMode(task)) system += PLAN_RULES;
  if (agent === task.targetAgent && mayAsk(task)) system += ASK_RULES;
  if (task.readOnly) system += READ_ONLY_RULES;
  if (agent === "file" && OBSIDIAN_VAULT && task.source !== "voice" && !task.readOnly) system += NOTE_RULES;
  if (opts.team) system += teamContext(agent, vaultNotes(OBSIDIAN_VAULT, agent));
  if (task.source !== "eval") system += projectPrompt(projects.get(task.project), OBSIDIAN_VAULT);
  return system;
}

// The parts that change on every call ride along with the request
async function userMessage(agent: AgentTarget, text: string, recallFor: string, team: boolean, project: string | null): Promise<string> {
  if (!team) return text;
  let memories: string[] = [];
  try {
    memories = await memory.recall(recallFor, agent, 6, project);
  } catch (error) {
    // A memory outage shouldn't stop the task; the run goes ahead without recalled memories
    hive.log("memory", "error", `recall failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return withLiveContext(text, { hive: hive.promptText(15, project), hivePublic: hive.publicText(15, project), memories });
}

const browsingEnabled = (task: Task) => Boolean(BROWSER_CDP_URL) && task.source !== "eval";

/**
 * An agent's vault notes (HQ/shared.md + HQ/agents/<agent>.md) for its live runs: the
 * browser's steps and the tool agent's calls build their own prompts, so they'd miss them.
 * Private like everywhere else: cloud models get nothing in their place.
 */
function liveVaultNotes(task: Task, agent: "browser" | "tools"): string {
  if (task.source === "eval") return "";
  const notes = vaultNotes(OBSIDIAN_VAULT, agent);
  return notes ? privateBlock(`NOTES FROM THE VAULT (the user's standing rules for you; follow them, but the reply format and safety rules above come first):\n${notes}`) : "";
}

/** Sites a read-only run may open: the card's list, or the sites named in its prompt, plus web search. */
function readOnlySites(task: Task): string[] {
  const named = task.allowedSites?.length
    ? task.allowedSites
    : [...`${task.prompt} ${task.reply ?? ""}`.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase().replace(/^www\./, ""));
  return [...new Set([...named, ...SEARCH_SITES])];
}

/** Drives the real browser for one request and returns the agent's answer. */
async function browse(task: Task, request: string, signal: AbortSignal, push: (text: string) => void, privateTask = false) {
  const sites = task.readOnly ? readOnlySites(task) : [];
  // Runs that may act sign in with a browser profile; read-only runs never do
  let profileName = task.readOnly ? undefined : task.profile ?? defaultProfile();
  // Another project's sign-ins are never used (the default profile may belong to one)
  const foreign = profileName ? profileProjectError(profileName, projects.idOf(task.project)) : null;
  if (foreign) {
    push(`[Browsing without sign-ins: ${foreign}]\n`);
    profileName = undefined;
  }
  let profile = profileName ? profileFor(profileName) : undefined;
  if (profile && "error" in profile) {
    push(`[Browsing without sign-ins: ${profile.error}]\n`);
    profileName = undefined;
    profile = undefined;
  }
  if (profileName && [...liveBrowsers.values()].some((b) => b.manual && b.profile === profileName)) {
    const open = liveBrowsers.get(`manual-${profileName}`);
    if (open) await closeProfileWindow(open);
    push(`[Closed your “${profileName}” profile window so this card can use its sign-ins]\n`);
    profile = profileFor(profileName!) as typeof profile;
  }
  const session = new BrowserSession({
    profile: profile && !("error" in profile) ? profile : undefined,
    allowPrivate: BROWSER_ALLOW_PRIVATE,
    readOnly: task.readOnly ? { allowedSites: sites } : undefined,
    // Runs that may act ask before typing, submitting or clicking a button
    gate: task.readOnly ? undefined : (req) => askApproval(task, "browser", req, signal),
    // A routine that may act still stays on its own sites
    sites: !task.readOnly && isRoutine(task) && task.allowedSites?.length ? [...task.allowedSites, ...SEARCH_SITES] : undefined,
    onFrame: (f: Frame) => broadcastBrowser({ type: "frame", taskId: task.id, ...f }),
    onBlocked: (url, reason) => {
      broadcastBrowser({ type: "blocked", taskId: task.id, url, reason });
      hive.log("browser", "blocked", `${url} (${reason})`, task.id);
    },
  });
  await session.start(BROWSER_CDP_URL);
  const lb: LiveBrowser = {
    id: task.id,
    taskId: task.id,
    title: task.title || task.prompt.slice(0, 80),
    profile: profileName,
    readOnly: Boolean(task.readOnly),
    manual: false,
    session,
    control: new BrowserControl(),
    lastInputAt: Date.now(),
  };
  lb.control = new BrowserControl((c) => controlEvent(lb, c));
  liveBrowsers.set(task.id, lb);
  if (profileName) push(`[Browser profile: ${profileName}]\n`);
  if (task.readOnly && sites.length === 1) {
    // Only web search is allowed: the run can read result snippets but open no result
    const msg = "This read-only run names no sites, so the browser can only read search results. Add allowed sites to the card to let it open pages.";
    push(`[${msg}]\n\n`);
    notices.add("read-only", "read-only:no-sites", msg);
  }
  // The dashboard is on this PC: it shows the request in full, without privacy markers
  broadcastBrowser({ type: "start", taskId: task.id, task: resolvePrivate(request, true).text });
  emit(task, "executing_tool");
  const vaultRules = liveVaultNotes(task, "browser");
  try {
    const answer = await runBrowserAgent({
      task: request,
      session,
      // A model picked for a Browser card drives its steps too (not a lead's model when Jarvis delegates)
      chat: roleJson("browser", { privateTask, override: task.targetAgent === "browser" ? task.modelOverride : undefined }),
      model: "browser",
      maxSteps: BROWSER_MAX_STEPS,
      signal,
      extraRules:
        [
          task.readOnly
            ? `READ-ONLY RUN: you may only open pages on ${sites.join(", ")} and follow links there. Typing, buttons and forms are disabled; use web search via navigate.`
            : "Typing, submitting and clicking buttons ask the user first and may be declined. If an action is declined, don't try it again; find another way or answer. " +
              "Never type passwords, payment details or ID numbers: tell the user to enter those themselves.",
          'The user may point at things on the page (pins #1, #2…). Use a pin as the target or field, e.g. {"action": "click", "target": "#1"}. Pins are lost when the page changes.',
          task.source === "voice" ? `When you answer: ${VOICE_STYLE}` : "",
          vaultRules,
        ]
          .filter(Boolean)
          .join("\n") || undefined,
      log: (line, kind) => {
        push(kind === "action" ? `🌐 ${line}\n` : `   ${kind === "error" ? "✗" : "✓"} ${line}\n`);
        broadcastBrowser({ type: "action", taskId: task.id, kind, line });
      },
      // You can take over between steps; the agent waits and then looks again
      beforeStep: async () => {
        const back = lb.control.state === "user" ? await waitForUser(task, lb.control, lb, signal, push) : null;
        // Notes the user sent from Annotate: they come from the user, not the page
        const notes = (lb.notes ?? []).splice(0);
        for (const n of notes) push(`📌 You: ${n.split("\n")[0].slice(0, 200)}\n`);
        return [back, ...notes.map((n) => `NEW INSTRUCTION FROM THE USER (not from the page; follow it): ${n}`)].filter(Boolean).join("\n") || null;
      },
      handoff: task.readOnly
        ? undefined
        : async (reason) => {
            lb.control.takeOver("agent", reason);
            notifyHandoff(task, reason);
            return waitForUser(task, lb.control, lb, signal, push);
          },
    });
    push(`\n${redact(answer).text}`);
    // Written after reading the vault notes, so private like any other agent's answer that saw them
    return { text: answer, sawPrivate: privateTask || Boolean(vaultRules) };
  } finally {
    liveBrowsers.delete(task.id);
    lb.control.handBack();
    await session.close();
    broadcastBrowser({ type: "end", taskId: task.id });
  }
}

/** What the installed tools do, for the router and the lead ("demo: echo (Repeats…), add_note (asks first: …)"). */
async function refreshToolsSummary(fresh = false) {
  if (!tools) return setToolsSummary(null);
  try {
    const servers = await tools.list(fresh);
    const parts = servers
      .filter((s) => s.ok)
      .map((s) => {
        const desc = (t: { readOnly: boolean; description: string }) => `${t.readOnly ? "" : "asks first: "}${t.description.replace(/\s+/g, " ").slice(0, 60)}`;
        return s.tools.length ? `${s.name}: ${s.tools.map((t) => `${t.name} (${desc(t)})`).join(", ")}` : "";
      })
      .filter(Boolean);
    const names = servers.filter((s) => s.ok).flatMap((s) => s.tools.map((t) => `${s.name}.${t.name}`));
    setToolsSummary(parts.length ? parts.join("; ") : null, names);
  } catch {
    setToolsSummary(null);
  }
}

/**
 * A Tools turn: the agent calls the installed tools step by step, then answers.
 * Read-only tools just run. A tool that changes things asks the user about that exact
 * call first, and isn't offered at all in routines or read-only runs.
 */
/**
 * Saves pictures and clips a tool made as files on the card you see (the top card, and the
 * delegated card too when there is one), so they show in its file bar. Returns the file names.
 */
function saveToolMedia(task: Task, title: string, media: ToolMedia[]): string[] {
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4" } as const;
  const saved = media.map((m) => ({ ...files.save(title, Buffer.from(m.data, "base64"), ext[m.mimeType]), at: Date.now() }));
  const cards = [task, ...(task.parentId ? [tasks.get(task.parentId)].filter((t): t is Task => Boolean(t)) : [])];
  for (const card of cards) {
    card.files = [...(card.files ?? []).filter((f) => !saved.some((s) => s.name === f.name)), ...saved];
    store.save(card);
  }
  return saved.map((s) => s.name);
}

async function useTools(task: Task, request: string, signal: AbortSignal, push: (text: string) => void, privateTask = false, evidence?: string[]): Promise<TurnResult> {
  if (!tools) throw new Error("No tools service is set up (TOOLS_URL)");
  // What private material the instructions carry: what the lead's handoff repeats (checked by
  // the caller), else the whole handoff when it wasn't checked, plus any private skill attached
  const carried = [...(evidence ?? (privateTask ? ["instructions written from your private notes or memories"] : [])), ...(hasPrivate(request) ? ["a private skill"] : [])];
  if (privateTask && evidence && !evidence.length) push("[The instructions don't repeat anything from your private notes or memories, so read-only tool calls won't ask.]\n");
  const servers = await tools.list();
  const available = toolsFor({ readOnly: task.readOnly, routine: isRoutine(task) }, servers);
  if (!available.length) throw new Error("no tools are installed that this card may use");
  const hidden = servers.flatMap((s) => (s.ok ? s.tools : [])).length - available.length;
  if (hidden > 0) push(`[${hidden > 1 ? `${hidden} tools that change things aren't` : "1 tool that changes things isn't"} available: ${isRoutine(task) ? "routines" : "read-only runs"} only use read-only tools.]\n`);
  const byName = new Map(available.map((t) => [`${t.server}.${t.name}`, t]));
  // The user's vault notes for Tools go in its prompt. They're private, so a call whose
  // arguments repeat something from them (a name, a number, a copied phrase) asks first;
  // words the tool list or the request already contain don't count.
  const vaultRules = liveVaultNotes(task, "tools");
  const vaultText = vaultRules ? splitPrivate([vaultRules]).private : "";
  const seenPublic = `${resolvePrivate(request, false).text}\n${available.map((t) => `${t.server} ${t.name} ${t.server}.${t.name} ${t.description}`).join("\n")}`;
  emit(task, "executing_tool");
  let calls = 0;
  const answer = await runToolAgent({
    task: request,
    tools: available,
    call: async (server, tool, args) => {
      calls++;
      const info = byName.get(`${server}.${tool}`);
      const shown = JSON.stringify(args);
      const where = { target: `${server}.${tool}`, text: shown, url: `tool:${server}.${tool}`, site: server };
      // A tool that changes things: the user approves this exact call (one that may destroy or
      // overwrite something always asks, whatever the settings). This also covers private context.
      // A read-only call whose instructions carry private material asks too, naming what it carries.
      const fromVault = vaultText ? carriedPrivate(shown, vaultText, seenPublic) : [];
      const details = [
        carried.length ? `its instructions include ${carried.join(", ")} from your private notes, memories or skills` : "",
        fromVault.length ? `it repeats ${fromVault.join(", ")} from your vault notes` : "",
      ].filter(Boolean);
      const detail = details.length ? details.join("; ") : undefined;
      const ask = info && !info.readOnly ? { kind: "change" as const, ...where, highRisk: isDestructive(info), detail } : details.length ? { kind: "tool" as const, ...where, detail } : null;
      if (ask) {
        const refusal = await askApproval(task, "tools", ask, signal);
        if (refusal) return { text: `Not done: ${refusal}. Don't try this call again; answer with what you have.`, isError: true, ms: 0 };
        hive.log("tools", "approved", `${server}.${tool} ${shown.slice(0, 120)}`, task.id);
      }
      const out = await tools.call(server, tool, args, { approved: Boolean(ask) });
      if (out.media?.length) {
        const names = saveToolMedia(task, `${server}-${typeof args.prompt === "string" ? args.prompt : tool}`, out.media);
        const clip = out.media.some((m) => m.mimeType === "video/mp4");
        const what = clip ? "clip" : "picture";
        push(`${clip ? "🎬" : "🖼"} ${clip ? "Clip" : "Picture"}${names.length > 1 ? "s" : ""} saved on the card: ${names.join(", ")}\n`);
        hive.log("tools", what, `${server}.${tool} → ${names.join(", ")}`, task.id);
        // The model only hears that it worked: file names read badly aloud and the card shows it
        return { ...out, media: undefined, text: `${out.text}\n(The ${what} is shown on the card. Say what it shows; don't give a file name.)` };
      }
      return out;
    },
    chat: roleJson("tools", { privateTask, override: task.targetAgent === "tools" ? task.modelOverride : undefined }),
    model: "tools",
    maxSteps: TOOLS_MAX_STEPS,
    signal,
    extraRules: vaultRules || undefined,
    log: (line, kind) => {
      push(kind === "action" ? `🔧 ${line}\n` : `   ${line}\n`);
      if (kind === "action") hive.log("tools", "call", line.slice(0, 160), task.id);
    },
  });
  if (!calls) push("[No tool call was needed.]\n");
  push(`\n${redact(answer).text}`);
  // Written after reading the vault notes, so private like any other agent's answer that saw them
  return { text: answer, sawPrivate: privateTask || Boolean(vaultRules) };
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
  /** For Tools: what private material the request repeats (when checked); empty means none */
  privateEvidence?: string[],
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
  if (agent === "tools" && tools && task.source !== "eval") {
    try {
      // Instructions that carry private material: each call asks first (see useTools)
      return await useTools(task, request, signal, push, privateTask, privateEvidence);
    } catch (error) {
      if (signal.aborted) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      push(`\n[Tools unavailable (${msg}); answering without them.]\n\n`);
      hive.log("tools", "error", msg, task.id);
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
    project: parent.project,
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
  // Routine runs are read-only unless their routine may act (with approvals)
  if (isRoutine(task)) task.readOnly = !task.mayAct;
  const onTimeout = () => {
    task.abortReason = "timeout";
    controller.abort();
  };
  let limitMs = taskTimeoutMs(task.targetAgent, task.targetAgent === "planner");
  let timeout = setTimeout(onTimeout, limitMs);
  // Time spent waiting for the user's approval doesn't count against the limit
  let pausedMs = 0;
  let pausedAt = 0;
  const elapsed = () => Date.now() - task.startedAt! - pausedMs;
  // Once the lead agent is known (after auto-routing), a slower agent can extend the limit
  const extendLimit = (agent: string, delegates: boolean) => {
    const want = taskTimeoutMs(agent, delegates);
    if (want <= limitMs) return;
    limitMs = want;
    if (pausedAt) return;
    clearTimeout(timeout);
    timeout = setTimeout(onTimeout, Math.max(0, want - elapsed()));
  };
  taskTimers.set(task.id, {
    pause: () => {
      if (pausedAt) return;
      pausedAt = Date.now();
      clearTimeout(timeout);
    },
    resume: () => {
      if (!pausedAt) return;
      pausedMs += Date.now() - pausedAt;
      pausedAt = 0;
      timeout = setTimeout(onTimeout, Math.max(0, limitMs - elapsed()));
    },
  });

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
    let makePdf = wantsPdf(ask);
    // "Make a video…": the Coder writes a Remotion scene and the video service renders it
    // A reply to a card whose last answer was a scene ("make the title bigger") renders again
    const lastAnswer = followUp ? [...(task.thread ?? [])].reverse().find((t) => t.role === "agent")?.text : undefined;
    let makeVideo = (wantsVideo(ask) || Boolean(lastAnswer && extractScene(lastAnswer))) && task.source !== "eval";
    // A plan-first run only writes the plan: no video, PDF, file edits or handoffs yet
    const planning = planMode(task);
    if (planning) {
      makePdf = false;
      makeVideo = false;
      push(`[Plan first: writing plan version ${(task.plan?.version ?? 0) + 1} for your review. Nothing runs until you approve it in the Inbox.]\n`);
    }
    const learned: string[] = [];
    const images = (task.images ?? []).map((id) => uploads.base64(id)).filter((b): b is string => Boolean(b));

    // Audio is transcribed first. The transcript is private, like the audio itself.
    let transcriptBlock = "";
    let transcript = "";
    // This run's request was spoken (nothing typed)
    let spokenNow = false;
    let heardPrivate = false;
    const clips = (task.audio ?? []).map((id) => uploads.bytes(id)).filter((b): b is Buffer => Boolean(b));
    if (clips.length) {
      const useWhisper = TRANSCRIBE_WITH === "whisper" && voice !== null;
      emit(task, "executing_tool", `── Transcribing ${clips.length} audio clip${clips.length > 1 ? "s" : ""} (${useWhisper ? "Whisper, voice service" : models.resolve("audio").ref}) ──\n\n`);
      const parts: string[] = [];
      for (const [i, clip] of clips.entries()) {
        const texts: string[] = [];
        // Whisper first (on the CPU, on this PC); the Transcriber model if it fails
        if (useWhisper && voice) {
          const heard = await voice.transcribe(clip, spellingHint(), controller.signal);
          if (!("error" in heard)) {
            const text = heard.text.replace(/\s+/g, " ").trim();
            parts.push(clips.length > 1 ? `Clip ${i + 1}: ${text || "(no speech found)"}` : text || "(no speech found)");
            continue;
          }
          const note = `Whisper couldn't transcribe this (${heard.error.slice(0, 120)}); using ${models.resolve("audio").ref} instead.`;
          push(`[${note}]\n`);
          hive.log("audio", "policy", note, task.id);
        }
        // Audio models take short clips (Gemma 4: 30 s), so long recordings go in pieces
        for (const piece of splitWav(clip)) {
          const out = await gateway.transcribe(
            piece,
            controller.signal,
            (note) => {
              push(`[${note}]\n`);
              hive.log("audio", "policy", note, task.id);
            },
            spellingHint(),
          );
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
      // Nothing typed (the stand-in prompt): what was said is the request
      const spoken = isSpokenRequest(task, ask) && transcript && transcript !== "(no speech found)";
      if (spoken) {
        spokenNow = true;
        spokenRequests.set(task.id, transcript);
        while (spokenRequests.size > 200) spokenRequests.delete(spokenRequests.keys().next().value!);
        if (!task.reply && (!task.title || task.title === task.prompt.slice(0, 80) || isStandIn(task.title))) task.title = transcript.slice(0, 80);
        makePdf ||= wantsPdf(transcript);
        makeVideo ||= wantsVideo(transcript) && task.source !== "eval";
        store.save(task);
      }
      transcriptBlock = privateBlock(
        spoken
          ? `THE USER'S REQUEST:\n${transcript}`
          : `TRANSCRIPT OF THE ATTACHED AUDIO:\n${transcript}`,
        "(The attached audio and its transcript stay on the user's PC and are withheld from cloud models.)",
      );
    }
    // A spoken request: the transcript replaces the stand-in prompt ("Listen to the attached audio…")
    // everywhere. `asked` is for local work (recall, skills, files); `askedForModel` keeps it private
    // from cloud models, which see the stand-in as before.
    const asked = spokenNow ? transcript : ask;
    const askedForModel = spokenNow ? privateBlock(transcript, ask) : ask;
    const pdfNote = makePdf ? pdfInstructions(task.images ?? []) : "";

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
                  `REQUEST: ${askedForModel}\n\nPART ${k + 1} OF ${kept.length} of ${label}, pages ${part.from + 1}–${part.to}:\n` +
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

    if (task.requestedAgent === "auto" && makeVideo) {
      // Videos are code: the Coder writes the Remotion scene (pictures go along as props)
      task.targetAgent = "coder";
      task.routedBy = "router";
      log("router", "routed", `→ coder (a video): ${spokenNow ? "(spoken request)" : ask}`);
    } else if (task.requestedAgent === "auto" && images.length) {
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
    const delegate = canDelegate && lead === "planner" && !planning;
    extendLimit(lead, delegate);
    let usedPrivate = heardPrivate;

    // Only the vision agent can see pictures. When another agent leads, Vision reads
    // them first and the lead gets its description, which is private like the pictures.
    // A spoken request replaces the stand-in prompt
    let request = [spokenNow ? "" : ask, transcriptBlock, docsBlock].filter(Boolean).join("\n\n");
    if (images.length && lead !== "vision") {
      openSub = addSubtask(task, "vision", `Describe the ${images.length} attached picture(s) for: ${asked.slice(0, 200)}`);
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
    if (makeVideo) {
      const plan = planVideo(task);
      if (plan.voice && !voice) push("[A voiceover was asked for, but no voice service is set up (VOICE_URL), so the video will be silent.]\n");
      request += videoInstructions({
        pictures: Math.min(images.length, 4),
        voice: plan.voice && Boolean(voice),
        captions: plan.captions,
        // The transcript itself is in the private block above
        recording: plan.recording && voice ? { seconds: audioSeconds(plan.recording), text: "" } : null,
        assets: assetBlock(plan.picked, plan.brand),
        vertical: plan.vertical,
      });
      if (plan.picked.length) push(`[Assets for this video: ${plan.picked.map((a) => a.name).join(", ")}]\n`);
    }
    // Workspace cards: the files, and how to change them
    const editsFiles = Boolean(task.workspace) && !task.readOnly && !isRoutine(task) && !planning;
    const workspace = editsFiles ? workspaceOf(task.project) : null;
    if (workspace) {
      workspace.ensure();
      request += workspaceBlock(workspace, asked, WORKSPACE_CONTEXT_CHARS);
      push(`[Workspace: ${workspace.name}]\n`);
    }
    // Approved skills that fit this request
    const leadSkills = useTeam ? skills.match(asked, lead, 2, projects.idOf(task.project)) : [];
    if (leadSkills.length) {
      push(`[Using skill${leadSkills.length > 1 ? "s" : ""}: ${leadSkills.map((s) => s.name).join(", ")}]\n`);
      for (const s of leadSkills) skills.recordUse(s.id);
      request += skillBlock(leadSkills);
    }

    const leadMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt(task, lead, { team: useTeam, delegate }) },
      ...history,
      {
        role: "user",
        content: await userMessage(lead, request, asked, useTeam, projects.idOf(task.project)),
        ...(lead === "vision" && images.length ? { images } : {}),
      },
    ];
    const firstTurn = await agentTurn(
      task,
      lead,
      leadMessages,
      // The browser agent works from this text alone, so a reply carries the original request
      (followUp ? `${askedForModel}\n\n(This follows up on the earlier request: ${task.prompt.slice(0, 500)})` : askedForModel) + pdfNote + skillBlock(leadSkills),
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
    // Teammates' file blocks (the lead's final answer may only summarize them)
    const mateEdits: string[] = [];
    if (handoffs.length) {
      task.delegatedTo = [];
      const results: { agent: AgentTarget; task: string; output: string; private: boolean }[] = [];
      // What the lead saw privately vs publicly (its own request counts as public), to tell
      // whether a handoff repeats any private material before its tool calls go outside
      const seen = splitPrivate(leadMessages.map((m) => m.content));
      seen.public += `\n${ask}`;
      for (const h of handoffs) {
        flush();
        task.activeAgent = h.agent;
        task.delegatedTo.push(h.agent);
        openSub = addSubtask(task, h.agent, h.task);
        log("planner", "delegated", `→ ${h.agent}: ${h.task}`);
        emit(task, "delegating", `\n\n── ${TEAM[h.agent].name} (${openSub.model}) ── ${h.task}\n\n`);
        emit(task, "thinking");
        const mateSkills = skills.match(h.task, h.agent, 2, projects.idOf(task.project)).filter((s) => !leadSkills.some((l) => l.id === s.id));
        if (mateSkills.length) {
          push(`[Using skill${mateSkills.length > 1 ? "s" : ""}: ${mateSkills.map((s) => s.name).join(", ")}]\n`);
          for (const s of mateSkills) skills.recordUse(s.id);
        }
        // Coder and File teammates get the workspace too
        const mateTask = h.task + skillBlock(mateSkills) + (workspace && (h.agent === "coder" || h.agent === "file") ? workspaceBlock(workspace, `${asked}\n${h.task}`, WORKSPACE_CONTEXT_CHARS) : "");
        const turn = await agentTurn(
          task,
          h.agent,
          [
            { role: "system", content: systemPrompt(task, h.agent, { team: true, delegate: false }) },
            {
              role: "user",
              content: await userMessage(h.agent, mateTask, h.task, true, projects.idOf(task.project)),
              // A handoff to Vision brings the card's pictures with it
              ...(h.agent === "vision" && images.length ? { images } : {}),
            },
          ],
          mateTask,
          controller.signal,
          push,
          undefined,
          // The lead wrote these instructions after seeing private material, so they may
          // carry it: the teammate stays local unless it may send private context to the cloud
          firstTurn.sawPrivate,
          // Outside tools ask first only when the instructions repeat something private
          h.agent === "tools" && firstTurn.sawPrivate ? carriedPrivate(h.task, seen.private, seen.public, seen.personal) : undefined,
        );
        const output = turn.text;
        usedPrivate ||= turn.sawPrivate;
        if (turn.ref) openSub.model = turn.ref;
        finishSubtask(openSub, "complete", output);
        openSub = null;
        // Remember which answers came from private material, so they're withheld if the lead runs in the cloud
        results.push({ agent: h.agent, task: h.task, output, private: turn.sawPrivate });
        if (workspace && (h.agent === "coder" || h.agent === "file")) mateEdits.push(output);
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
          { role: "user", content: await userMessage(lead, synthesisPrompt(askedForModel, results) + pdfNote, asked, true, projects.idOf(task.project)) },
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
    const notes = task.readOnly || isRoutine(task) ? [] : saveNotes(OBSIDIAN_VAULT, redact(answer).text);
    if (notes.length) push(`\n\n(Saved to vault: ${notes.map((n) => path.basename(n)).join(", ")})`);
    recordVault(task, `Notes from “${task.title || task.prompt.slice(0, 60)}”`, notes);
    // File edits: the teammates' first, then the lead's (a later block for the same file wins)
    if (workspace) {
      const ops = new Map<string, string | null>();
      for (const text of [...mateEdits, answer]) for (const op of extractFileOps(text)) ops.set(op.path, op.text);
      if (ops.size) {
        const out = changes.apply(
          { taskId: task.id, project: projects.idOf(task.project), label: task.reply ? `${task.title || task.prompt.slice(0, 60)} (reply)` : task.title || task.prompt.slice(0, 80), root: { kind: "workspace", name: workspace.name } },
          [...ops].map(([p, text]) => ({ path: p, text })),
        );
        if (out.set) {
          task.changes = [...(task.changes ?? []), out.set.id];
          const list = out.set.files.map((f) => `${f.path} (${f.before === null ? "new, " : f.after === null ? "deleted, " : ""}+${f.added} −${f.removed})`).join(", ");
          push(`\n\n📝 Changed ${out.set.files.length} file${out.set.files.length > 1 ? "s" : ""} in ${rootLabel(out.set.root)}: ${list}. Undo it from the card.\n`);
          log(lead, "files", `${out.set.files.length} file(s) changed in ${workspace.name}`);
        } else if (!out.errors.length) push("\n\n(The file blocks matched what's already there; nothing changed.)\n");
        for (const e of out.errors) push(`\n[Not written: ${e}]\n`);
      }
    }
    flush();
    task.answer = redact(answer.replace(/<note title="[^"]*">[\s\S]*?<\/note>/g, "")).text.trim();
    // Questions for the Inbox: taken out of the answer, posted, and named in one line at its end
    const fromAnswer = mayAsk(task) ? parseAsks(task.answer) : { asks: [], text: task.answer };
    if (fromAnswer.asks.length) {
      task.answer = fromAnswer.text;
      const posted = questions.post({ id: task.id, title: task.title || task.prompt.slice(0, 80), agent: lead }, fromAnswer.asks);
      task.answer += `\n\n${posted.map((q) => `❓ Waiting in your Inbox: ${q.question}${q.options.length ? ` (${q.options.join(" / ")})` : ""}`).join("\n")}`;
      for (const q of posted) log(lead, "question", q.question);
    }
    if (planning) {
      const version = (task.plan?.version ?? 0) + 1;
      task.plan = { status: "awaiting", version, text: fromAnswer.text, at: Date.now(), ...(task.plan?.lastReview ? { lastReview: task.plan.lastReview } : {}) };
      log(lead, "plan", `plan v${version} waiting for your review`);
    }
    log(lead, "complete", task.answer);
    // Read-only runs don't save memories either
    if (autoSkills() && worthASkill(task) && !skills.draftedFrom(task.id)) skillJobs.push(task.id);
    if (useTeam && !task.readOnly && !isRoutine(task) && task.answer) memoryJobs.push({ agent: lead, prompt: asked, answer: task.answer, private: usedPrivate, taskId: task.id, project: projects.idOf(task.project) });
    if (makeVideo && task.answer) {
      // Render, and let the lead fix the scene when Remotion can't render it
      let current = answer;
      for (let round = 0; ; round++) {
        const out = await renderVideo(task, current, images, controller.signal, push);
        if (out === "done" || out === "unfixable" || round >= VIDEO_FIX_ROUNDS) break;
        push(`\n── ${TEAM[lead].name} fixes the scene (try ${round + 2}) ──\n\n`);
        const fix = await streamTurn(
          task,
          lead,
          [
            { role: "system", content: systemPrompt(task, lead, { team: useTeam, delegate: false }) },
            { role: "user", content: await userMessage(lead, request, asked, useTeam, projects.idOf(task.project)) },
            { role: "assistant", content: current },
            {
              role: "user",
              content: `Rendering failed with this error:\n${out.error}\n\nFix the scene and reply with the whole file again in one \`\`\`tsx block, following the same rules.`,
            },
          ],
          controller.signal,
          push,
        );
        usedPrivate ||= fix.sawPrivate;
        // The fix is the scene alone: keep the narration from before
        const said = extractNarration(current);
        current = !extractNarration(fix.text) && said ? `${fix.text}\n\n\`\`\`narration\n${said}\n\`\`\`` : fix.text;
        task.answer = redact(current).text.trim();
      }
      flush();
    }
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
    taskTimers.delete(task.id);
    if (!task.parentId) historyIndex.put(task);
    approvals.endTask(task.id);
    task.awaitingApproval = undefined;
    task.finishedAt = Date.now();
    task.controller = undefined;
    task.activeAgent = undefined;
    store.save(task);
    notifyDone(task);
    // Answers you gave while it was running go back to it now
    deliverAnswers(task);
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
    await inProject(task.project, () => runTask(task));
  } finally {
    runningTaskId = null;
    store.trim();
    void pump();
  }
}

// A skill draft from a finished card, when nothing else is waiting
async function runSkillJob() {
  const id = skillJobs.shift();
  const task = id ? tasks.get(id) : undefined;
  if (!task) return runBookJob();
  backgroundBusy = true;
  try {
    const out = await inProject(task.project, () => draftSkill(task));
    if ("error" in out) hive.log("skills", "no draft", out.error, task.id);
  } catch (error) {
    hive.log("skills", "error", error instanceof Error ? error.message : String(error));
  } finally {
    backgroundBusy = false;
    void pump();
  }
}

// Memory extraction only runs when no task is waiting
async function runBackgroundJob() {
  const job = memoryJobs.shift();
  if (!job) return runSkillJob();
  backgroundBusy = true;
  try {
    const p = projects.get(job.project);
    const saved = await inProject(job.project, () => memory.extract(job.agent, job.prompt, job.answer, job.private, p ? { id: p.id, name: p.name, keepAll: p.localOnly } : null));
    // With the card's id, so it shows only in the card's project
    if (saved.length) hive.log("memory", "saved", saved.join("; "), job.taskId);
  } catch (error) {
    hive.log("memory", "error", error instanceof Error ? error.message : String(error));
  } finally {
    backgroundBusy = false;
    void pump();
  }
}

// --- Books (novels and ebooks) ------------------------------------------------------
// One model call at a time, between cards: a card that arrives while a chapter is being
// written waits for that chapter, never for the whole book. See src/hq/books.ts.
const books = new BookStore(path.join(DATA_DIR, "books"));
const BOOK_STEP_TIMEOUT_MS = Number(process.env.BOOK_STEP_TIMEOUT_MS) || 30 * 60_000;
/** The book step running now, and what the model has written so far (shown live on the Books page) */
let bookRun: { id: string; step: BookStep; label: string; controller: AbortController; text: string; startedAt: number } | null = null;

const bookModel: BookModel = {
  write: async (messages, signal, onToken) => {
    const out = await gateway.stream("writer", messages, signal, onToken, (note) => hive.log("writer", "policy", note));
    return { text: out.text, ref: out.ref };
  },
  json: async (messages) => {
    const out = await gateway.json("writer", messages, (note) => hive.log("writer", "policy", note));
    return { json: out.json ?? {}, ref: out.ref };
  },
  // Half the context for the prompt, half for the chapter; cloud models have room to spare
  contextChars: () => {
    const r = models.resolve("writer");
    return r.provider.local ? Math.floor((r.settings.numCtx || 8192) * 4 * 0.5) : 120_000;
  },
  // Picture books: one illustration per page from the images server (ComfyUI on this PC)
  ...(tools
    ? {
        illustrate: async (prompt: string, seed: number, size: "square" | "portrait" | "landscape") => {
          const out = await tools!.call("images", "generate_image", { prompt, seed, size }, { timeoutMs: 10 * 60_000 });
          const pic = out.media?.find((m) => m.mimeType.startsWith("image/"));
          if (out.isError || !pic) throw new Error(out.text.slice(0, 300) || "The picture tool made no picture");
          const saved = files.save("book-page", Buffer.from(pic.data, "base64"), pic.mimeType === "image/jpeg" ? "jpg" : pic.mimeType === "image/webp" ? "webp" : "png");
          return { name: saved.name, ref: "images.generate_image" };
        },
      }
    : {}),
};

async function runBookJob() {
  const next = books.next();
  if (!next) return;
  const { book, step } = next;
  backgroundBusy = true;
  const controller = new AbortController();
  bookRun = { id: book.id, step, label: describeStep(book, step), controller, text: "", startedAt: Date.now() };
  const name = `“${book.title || "Untitled"}”`;
  if (step.kind !== "summary") hive.log("writer", "book", `${bookRun.label}: ${name}`);
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(BOOK_STEP_TIMEOUT_MS)]);
    await inProject(book.project, () => runStep(book, step, bookModel, signal, (t) => bookRun && (bookRun.text += t)));
    book.error = undefined;
    book.failures = 0;
    settle(book);
    if (book.stage === "review") notices.add("book", `book:${book.id}`, `The outline for ${name} is ready: check it on the Books page, then approve it to start writing.`);
    if (book.stage === "done") {
      const words = book.chapters.reduce((n, c) => n + (c.words ?? 0), 0);
      hive.log("writer", "book", `finished ${name}: ${book.chapters.length} chapters, ${words.toLocaleString("en-US")} words`);
      notices.add("book", `book:${book.id}`, `${name} is finished (${words.toLocaleString("en-US")} words): download it from the Books page.`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted) book.paused = true;
    else {
      failed(book, controller.signal.aborted || /timeout|aborted/i.test(msg) ? `${bookRun.label} took too long (BOOK_STEP_TIMEOUT_MS)` : msg);
      hive.log("writer", "error", `${bookRun.label} (${name}): ${msg.slice(0, 200)}`);
      if (book.paused) notices.add("book", `book:${book.id}`, `${name} is paused: ${book.error}`);
    }
  } finally {
    // A book deleted while its step ran stays deleted
    if (books.get(book.id) === book) books.save(book);
    bookRun = null;
    backgroundBusy = false;
    void pump();
  }
}

setInterval(() => {
  memory
    .maintain()
    .then((stats) => {
      if (stats.decayed || stats.forgotten || stats.merged) hive.log("memory", "maintenance", JSON.stringify(stats));
    })
    .catch((error) => hive.log("memory", "error", `maintenance failed: ${error instanceof Error ? error.message : String(error)}`));
}, MEMORY_INTERVAL_MIN * 60 * 1000);

// --- Creating and changing cards ---------------------------------------------
const ROLE_LABEL: Record<string, string> = { planner: "Jarvis", coder: "Coder", browser: "Browser", file: "File", security_audit: "Security", vision: "Vision", tools: "Tools", router: "Router", memory: "Memory", audio: "Transcriber", writer: "Writer" };

/** "switch coder to claude" and friends change models without running a task. */
function handleSwitch(text: string): string | null {
  const presetName = parsePresetCommand(text);
  if (presetName) {
    const p = models.presets().find((x) => x.name.toLowerCase() === presetName || x.id === presetName.replace(/\s+/g, "-"));
    if (!p) return `There's no preset called "${presetName}". Presets: ${models.presets().map((x) => x.name).join(", ")}.`;
    return applyPresetNow(p.id);
  }
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

/** Switches the team to a preset and says what happened. */
function applyPresetNow(id: string): string {
  const out = models.applyPreset(id);
  if ("error" in out) return out.error;
  const p = models.preset(id)!;
  hive.log("models", "preset", `${p.name}${out.skipped.length ? ` (kept: ${out.skipped.map((s) => s.role).join(", ")})` : ""}`);
  return (
    `Switched to the “${p.name}” preset: ${out.applied.map((r) => `${ROLE_LABEL[r] ?? r} → ${models.settings().roles[r].model}`).join(", ")}.` +
    (out.skipped.length ? ` Kept their models: ${out.skipped.map((s) => `${ROLE_LABEL[s.role] ?? s.role} (${s.reason})`).join(", ")}.` : "")
  );
}

// The words of spoken requests (cards whose prompt is only the stand-in), by card
const spokenRequests = new Map<string, string>();
const STAND_INS = [/^listen to the attached audio and respond\.?$/i, /^\(?(voice|spoken) (note|request)\)?\.?$/i];
const isStandIn = (text: string) => STAND_INS.some((r) => r.test(text.trim()));
/** Whether a card's request is its recording: nothing was typed, only the stand-in prompt. */
function isSpokenRequest(task: Task, ask: string): boolean {
  return Boolean(task.audio?.length) && (isStandIn(ask) || !ask.trim());
}
/** Names the transcriber should spell right: the brand, projects, agents, assets. */
function spellingHint(): string {
  const names = new Set<string>(["Mission Control", "Jarvis", "Gamface", "Remotion", "Obsidian"]);
  const general = assets.brand(null).name;
  if (general) names.add(general);
  for (const p of projects.list(false)) {
    names.add(p.name);
    const b = assets.brand(p.id).name;
    if (b) names.add(b);
  }
  return [...names].join(", ");
}

/** A project's cards may only sign in with its own profiles or shared ones. */
function profileProjectError(profile: string, project: string | null): string | null {
  const owner = projects.ownerOfProfile(profile);
  return owner && owner.id !== project ? `The profile “${profile}” belongs to the project “${owner.name}”` : null;
}

function createTask(input: unknown, extra: { chatId?: string; routineId?: string; mayAct?: boolean } = {}): { task?: Task; status: number; error?: unknown } {
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
  if (d.profile && !profiles.exists(d.profile)) return { status: 400, error: `There's no browser profile called “${d.profile}”` };
  const project = d.project ? projects.get(d.project) : undefined;
  if (d.project && !project) return { status: 400, error: "Unknown project" };
  if (project?.archived) return { status: 400, error: `The project “${project.name}” is archived; restore it first` };
  const profileError = d.profile ? profileProjectError(d.profile, project?.id ?? null) : null;
  if (profileError) return { status: 400, error: profileError };
  // Routine runs are forced read-only and get exactly one destination
  const routine = routineFields(d, { telegramChat: telegram ? [...TELEGRAM_ALLOWED][0] : undefined, vault: OBSIDIAN_VAULT || undefined }, d.source === "routine" && extra.mayAct);
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
    // Routines run unattended, so nobody would be there to approve a plan
    planFirst: d.planFirst && d.source !== "routine" && d.source !== "eval" ? true : undefined,
    readOnly: routine.readOnly || undefined,
    deliverTo: routine.deliverTo,
    allowedSites: d.allowedSites.length ? d.allowedSites : undefined,
    profile: d.profile,
    project: project?.id,
    workspace: d.workspace && !routine.readOnly && d.source !== "routine" ? true : undefined,
    images: d.images.length ? d.images : undefined,
    audio: d.audio.length ? d.audio : undefined,
    documents: d.documents.length ? d.documents : undefined,
    position: now,
    createdAt: now,
    queuedAt: queueIt ? now : undefined,
    events: [],
    chatId: extra.chatId ?? routine.chatId,
    routineId: d.source === "routine" ? extra.routineId : undefined,
    mayAct: d.source === "routine" && extra.mayAct ? true : undefined,
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
  historyIndex.put(task);
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

/**
 * Renders the Remotion scene in an answer and adds the MP4 to the card.
 * "done", "unfixable" (no scene, or the service is down), or the error for the Coder to fix.
 */
async function renderVideo(
  task: Task,
  answer: string,
  images: string[],
  signal: AbortSignal,
  push: (t: string) => void,
  /** false when re-rendering a finished card: its status and output stay as they are */
  live = true,
): Promise<"done" | "unfixable" | { error: string }> {
  const scene: SceneSpec | null = extractScene(answer);
  if (!scene) {
    push("\n[No Remotion scene found in the answer, so there's no video to render.]\n");
    return "unfixable";
  }
  if (!video) {
    push("\n[The scene is ready, but no video service is set up (VIDEO_RENDER_URL). Start it with docker compose, then press 🎬 Render video on the card.]\n");
    return "unfixable";
  }
  // Rendering can take minutes; it doesn't count against the card's time limit
  const timers = taskTimers.get(task.id);
  timers?.pause();
  if (live) emit(task, "executing_tool");
  let shown = -1;
  try {
    const media = await videoMedia(task, answer, scene, signal, push);
    const notes = [media.voiceNote, media.captions ? "captions" : "", media.assetCount ? `${media.assetCount} asset${media.assetCount > 1 ? "s" : ""}` : ""].filter(Boolean);
    // Through the same buffer as the agent's text, so it lands after it
    push(
      `\n\n── Rendering the video with Remotion (${scene.width}×${scene.height}, ${scene.fps} fps, ${Math.round(scene.durationInFrames / scene.fps)} s${notes.length ? `; ${notes.join(", ")}` : ""}) ──\n`,
    );
    const props = {
      images: (task.images ?? [])
        .slice(0, 4)
        .map((id, i) => (images[i] ? `data:image/${id.endsWith(".jpg") ? "jpeg" : id.split(".").pop()};base64,${images[i]}` : null))
        .filter(Boolean),
      ...media.props,
    };
    const out = await video.render(
      scene,
      props,
      (p) => {
        const step = p.stage === "rendering" ? Math.floor(p.progress / 20) * 20 : p.stage === "bundling" ? 0 : -2;
        if (step !== shown) {
          shown = step;
          push(p.stage === "queued" ? "  waiting for another video to finish…\n" : p.stage === "bundling" ? "  bundling the scene…\n" : `  rendering ${step}%\n`);
        }
      },
      signal,
      media.files,
    );
    if ("error" in out) {
      push(`\n✗ Remotion couldn't render it:\n${out.error}\n`);
      hive.log("coder", "video", `render failed: ${out.error.split("\n")[0]}`, task.id);
      return out.fixable ? { error: out.error } : "unfixable";
    }
    assets.recordUse(media.assetIds);
    const title = /\/\/\s*title:\s*([^\n]+)/i.exec(scene.code)?.[1] ?? task.title ?? task.prompt.slice(0, 60);
    const saved = files.save(title, out.mp4, "mp4");
    task.files = [...(task.files ?? []).filter((f) => f.name !== saved.name), { ...saved, at: Date.now() }];
    store.save(task);
    push(`\n🎬 Video saved: ${saved.name} (${saved.bytes >= 1024 * 1024 ? `${(saved.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(saved.bytes / 1024))} KB`}). Play it from the card.\n`);
    hive.log("coder", "video", `rendered ${saved.name}`, task.id);
    return "done";
  } finally {
    timers?.resume();
  }
}

interface VideoPlan {
  voice: boolean;
  captions: boolean;
  /** The attached recording to use as the soundtrack */
  recording: string | null;
  picked: Asset[];
  brand: Brand | null;
  vertical: boolean;
}

/** What a video request asks for, from everything the user said on the card. */
function planVideo(task: Task): VideoPlan {
  const said = [task.prompt, spokenRequests.get(task.id) ?? "", ...(task.thread ?? []).filter((t) => t.role === "user").map((t) => t.text), task.reply ?? ""].join("\n");
  const clips = [...(task.audio ?? []), ...(task.thread ?? []).flatMap((t) => t.audio ?? [])];
  return {
    voice: wantsVoice(said),
    captions: wantsCaptions(said),
    recording: wantsOwnAudio(said) && clips.length ? clips[clips.length - 1] : null,
    picked: assets.pick(said, undefined, projects.idOf(task.project)),
    brand: assets.branded(projects.idOf(task.project)) ? assets.brand(projects.idOf(task.project)) : null,
    vertical: wantsVertical(said),
  };
}

const audioSeconds = (id: string) => {
  const buf = uploads.bytes(id);
  return (buf && parseWav(buf)?.seconds) || 0;
};

// Word timings of attached recordings, by upload id
const recordingWords = new Map<string, { words: Word[]; seconds: number }>();

/**
 * The voiceover (spoken from the answer's narration, or the user's own recording),
 * its word timings, music with its beats, the assets and the brand, as files and
 * props for the renderer. Lengthens the scene to fit the voiceover.
 */
async function videoMedia(
  task: Task,
  answer: string,
  scene: SceneSpec,
  signal: AbortSignal,
  push: (t: string) => void,
): Promise<{ props: Record<string, unknown>; files: { name: string; base64: string }[]; assetIds: string[]; assetCount: number; voiceNote: string; captions: boolean }> {
  const plan = planVideo(task);
  const brand = assets.brand(projects.idOf(task.project));
  const files: { name: string; base64: string }[] = [];
  let words: Word[] = [];
  let audio: string | null = null;
  let seconds = 0;
  let voiceNote = "";

  // A reply ("make the title bigger") or a fix may leave the narration out: keep the last one
  const lastNarration = () =>
    [...(task.thread ?? [])]
      .reverse()
      .filter((t) => t.role === "agent")
      .map((t) => extractNarration(t.text))
      .find(Boolean) ?? null;
  const narration = plan.recording ? null : (extractNarration(answer) ?? (plan.voice ? lastNarration() : null));
  if (plan.recording && voice) {
    const clip = uploads.bytes(plan.recording);
    if (clip) {
      let timed = recordingWords.get(plan.recording);
      if (!timed) {
        push("  timing the words of your recording…\n");
        const out = await voice.words(clip, undefined, signal);
        if ("error" in out) push(`  [Couldn't time the recording's words: ${out.error}]\n`);
        else recordingWords.set(plan.recording, (timed = { words: out.words, seconds: out.seconds }));
      }
      files.push({ name: "voice.wav", base64: clip.toString("base64") });
      audio = "voice.wav";
      words = timed?.words ?? [];
      seconds = audioSeconds(plan.recording) || timed?.seconds || 0;
      voiceNote = "your recording";
    }
  } else if (narration && voice) {
    const { voice: who, speed } = sceneVoice(scene.code, brand.voice);
    push(`  speaking the narration (${KNOWN_VOICES[who]?.split(" (")[0] ?? who})…\n`);
    const out = await voice.speak(narration, who, speed, signal);
    if ("error" in out) push(`  [No voiceover: ${out.error}]\n`);
    else {
      files.push({ name: "voice.wav", base64: out.wav.toString("base64") });
      audio = "voice.wav";
      words = out.words;
      seconds = out.seconds;
      voiceNote = `voiceover ${Math.round(out.seconds)} s`;
    }
  } else if (narration && !voice) push("  [The answer has narration, but no voice service is set up (VOICE_URL), so the video is silent.]\n");

  if (seconds > 0) {
    // At least as long as the voiceover, plus a breath at the end
    const need = Math.ceil((seconds + 0.6) * scene.fps);
    const max = Math.floor(VIDEO_MAX_SECONDS * scene.fps);
    if (need > max) push(`  [The voiceover is ${Math.round(seconds)} s, longer than the ${VIDEO_MAX_SECONDS} s limit (VIDEO_MAX_SECONDS); the end is cut off.]\n`);
    scene.durationInFrames = Math.min(max, Math.max(scene.durationInFrames, need));
  }

  // Assets: the ones that match, plus the brand logo and font
  const chosen = [...plan.picked, ...assets.brandAssets(projects.idOf(task.project)).filter((b) => !plan.picked.some((p) => p.id === b.id))];
  const assetProps: Record<string, { file: string; kind: string; name: string; seconds?: number }> = {};
  let music: { file: string; beats: number[]; tempo: number | null } | null = null;
  for (const a of chosen) {
    const buf = assets.bytes(a.id);
    if (!buf) continue;
    files.push({ name: publicName(a), base64: buf.toString("base64") });
    assetProps[a.id] = { file: publicName(a), kind: a.kind, name: a.name, seconds: a.seconds };
    if (a.role === "music" && !music) {
      let current = a;
      if (!a.beats && voice) {
        const found = await voice.beats(buf);
        if (!("error" in found)) current = assets.update(a.id, { tempo: found.tempo, beats: found.beats, seconds: a.seconds ?? found.seconds }) ?? a;
      }
      music = { file: publicName(a), beats: current.beats ?? [], tempo: current.tempo ?? null };
    }
  }
  const captions = plan.captions && words.length > 0;
  return {
    props: {
      words,
      audio,
      music,
      assets: assetProps,
      brand: {
        name: brand.name,
        tagline: brand.tagline,
        primary: brand.primary,
        secondary: brand.secondary,
        accent: brand.accent,
        background: brand.background,
        text: brand.text,
        font: brand.font === "brand" && brand.fontAsset ? "brand" : brand.font === "brand" ? "sans-serif" : brand.font,
        logo: brand.logo,
      },
      captions: { auto: captions, style: brand.captionStyle, position: "bottom" },
    },
    files,
    assetIds: chosen.map((a) => a.id),
    assetCount: plan.picked.length,
    voiceNote,
    captions,
  };
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
  // Replying to a plan that waits for review asks for another version of it
  if (task.plan?.status === "awaiting") task.plan = { ...task.plan, status: "revising" };
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
  if (p.planFirst !== undefined) {
    if (!editable) return { error: "Only cards in Backlog or Ready can change plan first" };
    if (isRoutine(task)) return { error: "Routine cards run unattended, so they can't wait for a plan review" };
    task.planFirst = p.planFirst || undefined;
  }
  if (p.readOnly !== undefined) {
    if (!editable) return { error: "Only cards in Backlog or Ready can change read-only mode" };
    task.readOnly = p.readOnly || undefined;
  }
  if (p.allowedSites !== undefined) task.allowedSites = p.allowedSites.length ? p.allowedSites : undefined;
  if (p.workspace !== undefined) {
    if (!editable) return { error: "Only cards in Backlog or Ready can change workspace editing" };
    task.workspace = p.workspace && !isRoutine(task) ? true : undefined;
  }
  if (p.project !== undefined) {
    const to = p.project ? projects.get(p.project) : undefined;
    if (p.project && !to) return { error: "Unknown project" };
    if (to?.archived) return { error: `The project “${to.name}” is archived` };
    if (RUNNING_STATUSES.includes(task.status)) return { error: "A running card can't change project" };
    const keep = p.profile !== undefined ? p.profile : task.profile;
    if (keep && profileProjectError(keep, to?.id ?? null)) return { error: `${profileProjectError(keep, to?.id ?? null)}. Pick another profile first.` };
    task.project = to?.id;
    historyIndex.put(task);
  }
  if (p.profile !== undefined) {
    if (p.profile && !profiles.exists(p.profile)) return { error: `There's no browser profile called “${p.profile}”` };
    const err = p.profile ? profileProjectError(p.profile, projects.idOf(task.project)) : null;
    if (err) return { error: err };
    task.profile = p.profile ?? undefined;
  }
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
      const file = saveRoutineNote(OBSIDIAN_VAULT, task.title || "routine", task.answer);
      recordVault(task, `Routine note “${task.title || "routine"}”`, [file]);
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
    decide: (code, approve, scope) => approvals.decide(code, approve, "telegram", scope),
    pendingText: () => approvals.pending().map((a) => `${a.code}: ${describeAction(a)}${a.risk === "high" ? " ⚠" : ""} (card: ${a.taskTitle})`).join("\n"),
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
// The graphics card's memory, for the dashboard's VRAM bar
const GPU_VRAM_GB = Number(process.env.GPU_VRAM_GB) || 16;
// How many notes the vault holds and when one last changed (counted at most every 30 s)
let vaultCache: { at: number; notes: number; lastChange: number } | null = null;
function vaultStats(): { notes: number; lastChange: number } | null {
  if (!OBSIDIAN_VAULT) return null;
  if (vaultCache && Date.now() - vaultCache.at < 30_000) return vaultCache;
  let notes = 0;
  let lastChange = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || notes > 20_000) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSyncFs(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(".md")) {
        notes++;
        try {
          lastChange = Math.max(lastChange, statSyncFs(full).mtimeMs);
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(OBSIDIAN_VAULT, 0);
  vaultCache = { at: Date.now(), notes, lastChange };
  return vaultCache;
}

app.get("/api/system", async (_req: Request, res: Response) => {
  const queueInfo = {
    running: runningTaskId,
    queued: store.queuedCount(),
    fastModel: models.resolve("router").ref,
    preset: models.activePreset()?.name ?? null,
    telegram: Boolean(telegram),
    obsidian: Boolean(OBSIDIAN_VAULT),
    browser: Boolean(BROWSER_CDP_URL),
    video: Boolean(video),
    voice: Boolean(voice),
    memories: await memory.count().catch(() => 0),
    memoryStore: memory.storeKind,
    lastModel: lastModelRef,
    notices: notices.list().length,
    speed: gateway.lastSpeed,
    vault: vaultStats(),
    agents: Object.fromEntries(AGENT_KEYS.map((a) => [a, { model: models.resolve(a).ref, localOnly: models.settings().roles[a].localOnly }])),
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
    const vramUsedGB = Math.round(((ps.models ?? []).reduce((n, m) => n + (m.size_vram || 0), 0) / 1024 ** 3) * 10) / 10;
    res.json({ ollama: "up", url: OLLAMA_BASE_URL, model, models: loaded, vramUsedGB, vramTotalGB: GPU_VRAM_GB, ...queueInfo });
  } catch {
    res.json({ ollama: "down", url: OLLAMA_BASE_URL, model, models: [], vramUsedGB: 0, vramTotalGB: GPU_VRAM_GB, ...queueInfo });
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
  // Archived cards open too (from history search), read from disk
  const task = store.find(String(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });
  res.json({
    ...summarize(task),
    archived: (task as { archived?: boolean }).archived || undefined,
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

// Render (again) the Remotion scene in a finished card's answer
app.post("/api/tasks/:id/video", requireToken, async (req, res) => {
  const task = tasks.get(String(req.params.id));
  if (!task || task.parentId) return res.status(404).json({ error: "Task not found" });
  if (!TERMINAL_STATUSES.includes(task.status) || !task.answer) return res.status(400).json({ error: "Wait for the card to finish" });
  if (!extractScene(task.answer)) return res.status(400).json({ error: "This card's answer has no Remotion scene" });
  if (!video) return res.status(400).json({ error: "No video service is set up (VIDEO_RENDER_URL)" });
  const lines: string[] = [];
  const images = (task.images ?? []).map((id) => uploads.base64(id)).filter((b): b is string => Boolean(b));
  const out = await renderVideo(task, task.answer, images, AbortSignal.timeout(30 * 60_000), (t) => lines.push(t), false);
  if (out !== "done") {
    const why = typeof out === "object" ? out.error : lines.join("").trim();
    return res.status(422).json({ error: why || "The video couldn't be rendered" });
  }
  res.json({ files: task.files });
});

// --- Books ---------------------------------------------------------------------------

function bookView(b: Book) {
  const run = bookRun?.id === b.id ? bookRun : null;
  const step = nextStep(b);
  return {
    ...bookDetail(b),
    next: step ? describeStep(b, step) : null,
    running: run ? { label: run.label, step: run.step, text: run.text.slice(-8000), startedAt: run.startedAt } : null,
  };
}

function bookOr404(req: Request, res: Response): Book | null {
  const b = books.get(String(req.params.id));
  if (!b) res.status(404).json({ error: "Book not found" });
  return b ?? null;
}

const isRunning = (b: Book) => bookRun?.id === b.id;

function bookCover(b: Book): { data: Buffer; mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif" } | undefined {
  const up = b.cover ? uploads.read(b.cover) : null;
  if (!up || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(up.type)) return undefined;
  return { data: up.buf, mime: up.type as "image/png" };
}

/** A book's saved illustrations, for the EPUB and the PDFs. */
const bookImage: ImageLoader = (name) => {
  const buf = files.read(name);
  if (!buf) return null;
  const mime = fileType(name);
  return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" ? { data: buf, mime } : null;
};
const bookImageUri = (name: string) => {
  const img = bookImage(name);
  return img ? `data:${img.mime};base64,${img.data.toString("base64")}` : null;
};

app.get("/api/books", (req, res) => {
  const p = typeof req.query.project === "string" && req.query.project !== "all" ? projects.idOf(req.query.project === "general" ? null : req.query.project) : undefined;
  const list = books.list(p);
  res.json({
    books: list.map((b) => ({ ...bookSummary(b), running: isRunning(b) ? bookRun!.label : null })),
    writer: models.resolve("writer").ref,
    pdf: Boolean(BROWSER_CDP_URL),
    pictures: Boolean(tools),
    trims: Object.keys(TRIMS).filter((t) => t !== "letter"),
  });
});

app.get("/api/books/:id", (req, res) => {
  const b = bookOr404(req, res);
  if (b) res.json(bookView(b));
});

app.post("/api/books", requireToken, (req, res) => {
  const made = newBook(req.body ?? {});
  if ("error" in made) return res.status(400).json(made);
  if (made.project && !projects.get(made.project)) return res.status(400).json({ error: "Unknown project" });
  books.save(made);
  hive.log("writer", "book", `new ${made.kind}: ${made.title || made.brief.slice(0, 80)}`);
  void pump();
  res.status(201).json(bookView(made));
});

app.patch("/api/books/:id", requireToken, (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const edits = Object.keys(body).filter((k) => k !== "paused");
  if (edits.length && isRunning(b)) return res.status(409).json({ error: `Wait for “${bookRun!.label}” to finish, or pause the book first` });
  if (typeof body.cover === "string" && body.cover && !uploads.exists(body.cover)) return res.status(400).json({ error: "Unknown picture: upload it first" });
  const err = editBook(b, body);
  if (err) return res.status(400).json({ error: err });
  if (body.paused === true && b.stage !== "done") {
    b.paused = true;
    if (isRunning(b)) bookRun!.controller.abort();
  } else if (body.paused === false) {
    b.paused = false;
    b.error = undefined;
    b.failures = 0;
  }
  books.save(b);
  void pump();
  res.json(bookView(b));
});

app.post("/api/books/:id/approve", requireToken, (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  if (b.stage !== "review" || !b.chapters.length) return res.status(400).json({ error: "There's no outline waiting for approval" });
  b.stage = "writing";
  b.paused = false;
  b.error = undefined;
  b.failures = 0;
  books.save(b);
  hive.log("writer", "book", `outline approved: “${b.title || "Untitled"}” (${b.chapters.length} chapters)`);
  void pump();
  res.json(bookView(b));
});

/** Plans again: the story bible and outline ({what: "bible"}), or only the outline. */
app.post("/api/books/:id/replan", requireToken, (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  if (isRunning(b)) return res.status(409).json({ error: "Pause the book first" });
  if (b.chapters.some((c) => c.text) && req.body?.force !== true) return res.status(400).json({ error: "Chapters are already written; planning again would throw them away (send force: true to do it anyway)" });
  if (req.body?.what === "bible") b.bible = "";
  b.chapters = [];
  b.stage = "planning";
  b.paused = false;
  b.error = undefined;
  b.failures = 0;
  books.save(b);
  void pump();
  res.json(bookView(b));
});

app.post("/api/books/:id/chapters/:n/rewrite", requireToken, (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  if (isRunning(b)) return res.status(409).json({ error: "Pause the book first" });
  const part = req.body?.part === "picture" || req.body?.part === "puzzle" ? req.body.part : "text";
  const err = rewriteChapter(b, Number(req.params.n), typeof req.body?.note === "string" ? req.body.note : undefined, part);
  if (err) return res.status(400).json({ error: err });
  books.save(b);
  void pump();
  res.json(bookView(b));
});

/** Turns a recording into text: Whisper on the voice service first, the Transcriber model if it fails. */
async function transcribeForBook(wav: Buffer, project: string | null): Promise<string> {
  if (TRANSCRIBE_WITH === "whisper" && voice) {
    const heard = await voice.transcribe(wav, spellingHint());
    if (!("error" in heard)) return heard.text.trim();
  }
  const texts: string[] = [];
  for (const piece of splitWav(wav)) texts.push((await inProject(project, () => gateway.transcribe(piece, undefined, (note) => hive.log("audio", "policy", note), spellingHint()))).text);
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Adds source material to a book: {kind: "url", url} (a page, a public Google Doc, a
 * YouTube video's captions, a PDF or Word file), {kind: "text", text, name},
 * {kind: "pdf" | "audio", upload} (an id from POST /api/uploads) or {kind: "docx", data, name} (base64).
 */
app.post("/api/books/:id/sources", requireToken, async (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  if (isRunning(b)) return res.status(409).json({ error: "Pause the book first" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = String(body.kind ?? "");
  try {
    let got: { kind: SourceKind; name: string; origin?: string; text: string };
    if (kind === "url") {
      const url = typeof body.url === "string" ? body.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Give a web address starting with http:// or https://" });
      const out = await fetchSource(url, { allowPrivate: BROWSER_ALLOW_PRIVATE });
      if ("buf" in out) {
        const text = out.kind === "pdf" ? (await extractPdf(out.buf, out.title)).pages.join("\n\n") : docxToText(out.buf);
        got = { kind: out.kind, name: out.title, origin: url, text };
      } else got = { kind: out.kind, name: out.title, origin: url, text: out.text };
    } else if (kind === "text") {
      got = { kind: "text", name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Pasted text", text: typeof body.text === "string" ? body.text : "" };
    } else if (kind === "pdf") {
      const buf = typeof body.upload === "string" ? uploads.bytes(body.upload) : null;
      if (!buf) return res.status(400).json({ error: "Upload the PDF first (POST /api/uploads)" });
      const pdf = await extractPdf(buf, typeof body.name === "string" ? body.name : "document.pdf");
      if (pdf.scanned) return res.status(400).json({ error: "That PDF is scanned pages with no text layer; run it through OCR first" });
      got = { kind: "pdf", name: typeof body.name === "string" ? body.name : pdf.title || "PDF", text: pdf.pages.join("\n\n") };
    } else if (kind === "docx") {
      const data = typeof body.data === "string" ? body.data.replace(/^data:[^;,]*;base64,/, "") : "";
      const buf = Buffer.from(data, "base64");
      if (!buf.length || buf.length > 30 * 1024 * 1024) return res.status(400).json({ error: "Send the Word file as base64 (at most 30 MB)" });
      got = { kind: "docx", name: typeof body.name === "string" ? body.name : "Word document", text: docxToText(buf) };
    } else if (kind === "audio") {
      const wav = typeof body.upload === "string" ? uploads.bytes(body.upload) : null;
      if (!wav || !parseWav(wav)) return res.status(400).json({ error: "Upload the recording first (POST /api/uploads with kind audio)" });
      got = { kind: "audio", name: typeof body.name === "string" ? body.name : "Recording", text: await transcribeForBook(wav, b.project) };
    } else return res.status(400).json({ error: "kind must be url, text, pdf, docx or audio" });
    const added = addSource(b, got);
    if ("error" in added) return res.status(400).json(added);
    books.save(b);
    hive.log("writer", "book", `source added to “${b.title || "Untitled"}”: ${added.name} (${added.text.length.toLocaleString("en-US")} characters)`);
    res.status(201).json(bookView(b));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/api/books/:id/sources/:sid", requireToken, (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  if (isRunning(b)) return res.status(409).json({ error: "Pause the book first" });
  if (!removeSource(b, String(req.params.sid))) return res.status(404).json({ error: "Source not found" });
  books.save(b);
  res.json(bookView(b));
});

/** Asks for a listing kit (description, back cover, keywords, categories); it runs as the book's next step. */
app.post("/api/books/:id/listing", requireToken, (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  if (!b.bible) return res.status(400).json({ error: "Plan the book first" });
  b.listing = undefined;
  b.wantListing = true;
  b.paused = false;
  b.error = undefined;
  b.failures = 0;
  books.save(b);
  void pump();
  res.json(bookView(b));
});

/**
 * KDP paperback files: the interior, printed until its gutter matches its page count and
 * padded to KDP's 24-page minimum, and the full cover sized from that page count.
 */
app.post("/api/books/:id/kdp", requireToken, async (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  if (!BROWSER_CDP_URL) return res.status(400).json({ error: "KDP files are printed by the browser sidecar: set BROWSER_CDP_URL (see README-HQ)" });
  if (!b.chapters.some((c) => c.text || c.image)) return res.status(400).json({ error: "Nothing is written yet" });
  const trim = (typeof req.body?.trim === "string" && req.body.trim in TRIMS ? req.body.trim : trimOf(b)) as Trim;
  const paper: Paper = req.body?.paper === "cream" || req.body?.paper === "color" ? req.body.paper : b.kind === "picture" ? "color" : "white";
  const footer = b.kind === "picture" ? "none" : "number";
  try {
    // The gutter depends on the page count, which depends on the gutter: print until they agree
    let pages = 100;
    let pdf: Buffer = Buffer.alloc(0);
    for (let pass = 0; pass < 3; pass++) {
      pdf = await printPdf(bookHtml(b, { trim, kdp: { pages }, image: bookImageUri }), BROWSER_CDP_URL, { footer });
      const counted = await pdfPageCount(pdf);
      const settled = gutterFor(counted) === gutterFor(pages);
      pages = counted;
      if (settled) break;
    }
    const notes: string[] = [];
    if (pages < MIN_PAGES) {
      notes.push(`Padded from ${pages} to ${MIN_PAGES} pages, KDP's minimum${b.kind === "picture" ? " (with a “This book belongs to” page)" : ""}.`);
      pdf = await printPdf(bookHtml(b, { trim, kdp: { pages, padTo: MIN_PAGES }, image: bookImageUri }), BROWSER_CDP_URL, { footer });
      pages = await pdfPageCount(pdf);
    }
    if (pages > MAX_PAGES) return res.status(400).json({ error: `${pages} pages is over KDP's paperback limit of ${MAX_PAGES}: use a larger trim size` });
    const spec = coverSpec(trim, pages, paper);
    const front = bookCover(b);
    const firstPicture = b.kind === "picture" ? b.chapters.find((c) => c.image)?.image : undefined;
    const image = front ? `data:${front.mime};base64,${front.data.toString("base64")}` : firstPicture ? (bookImageUri(firstPicture) ?? undefined) : undefined;
    const coverPdf = await printPdf(
      coverHtml(spec, { title: b.title || "Untitled", subtitle: b.subtitle, author: b.author, blurb: b.listing?.backCover || b.brief, image }),
      BROWSER_CDP_URL,
      { footer: "none" },
    );
    const interior = files.save(`${b.title || "book"}-interior`, pdf);
    const cover = files.save(`${b.title || "book"}-cover`, coverPdf);
    if (!spec.spineText) notes.push(`No spine text: KDP only allows it from 80 pages.`);
    if (b.kind === "picture") notes.push("In KDP choose “Bleed” for the interior: the pictures run to the page edge.");
    notes.push(`In KDP choose ${paper === "color" ? "premium colour" : `${paper} paper`} and ${trim === "letter" ? "8.5 x 11" : trim.replace("x", " x ")} in: the cover was sized for that paper.`);
    if (!b.listing) notes.push("The back cover uses your brief; make a listing kit first for proper back-cover copy.");
    hive.log("writer", "book", `KDP files for “${b.title || "Untitled"}”: ${pages} pages, ${spec.width}×${spec.height} in cover`);
    res.json({
      interior: { ...interior, url: `/api/files/${interior.name}`, pages },
      cover: { ...cover, url: `/api/files/${cover.name}`, ...spec },
      trim,
      paper,
      notes,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- Music studio (studio/: its own container; songs and GPU stems through ComfyUI) --------
// The dashboard talks to the studio through here, so the studio itself is never published.
// Reading is open like the rest of the API; changes need the token.
const STUDIO_ROUTES: { method: string; path: RegExp }[] = [
  { method: "GET", path: /^\/(health|songs|jobs|outputs|media|import)$/ },
  { method: "POST", path: /^\/(media|songs\/import)$/ },
  { method: "GET", path: /^\/(songs|jobs)\/[a-f0-9]{12}$/ },
  { method: "GET", path: /^\/files\/[A-Za-z0-9._/-]+$/ },
  { method: "POST", path: /^\/(songs|jobs)$/ },
  { method: "POST", path: /^\/jobs\/[a-f0-9]{12}\/cancel$/ },
  { method: "DELETE", path: /^\/songs\/[a-f0-9]{12}$/ },
];

/** The harness's own calls to the studio (Jarvis's studio tools). Throws the studio's error. */
async function studioFetch(sub: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  if (!STUDIO_URL) throw new Error("The music studio isn't set up (STUDIO_URL)");
  let r: globalThis.Response;
  try {
    r = await fetch(`${STUDIO_URL}${sub}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.method === "POST" ? 5 * 60_000 : 30_000),
    });
  } catch (e) {
    throw new Error(`The music studio isn't answering (docker compose up -d studio): ${e instanceof Error ? e.message : String(e)}`);
  }
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error ?? `The studio said ${r.status}`);
  if (init.method === "POST" && sub === "/jobs") hive.log("studio", "job", String((data as { title?: string }).title ?? "studio job"));
  if (init.method === "POST" && sub === "/songs/import") hive.log("studio", "song", `added “${String((data as { title?: string }).title ?? "a song")}” from the Music folder`);
  return data;
}

// Lyrics for the Studio page's "Add vocals" form, written by the lead's model
app.post("/api/studio/lyrics", requireToken, async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  try {
    const lyrics = await writeLyrics(roleJson("planner"), { theme: s(b.theme, 600), style: s(b.style, 300), title: s(b.title, 120), seconds: n(b.seconds), bpm: n(b.bpm), key: s(b.key, 20), language: s(b.language, 8) });
    res.json({ lyrics });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.use("/api/studio", async (req: Request, res: Response) => {
  const [sub, query = ""] = (req.url ?? "/").split("?");
  if (!STUDIO_ROUTES.some((r) => r.method === req.method && r.path.test(sub)) || sub.includes("..")) return res.status(404).json({ error: "Not found" });
  if (!STUDIO_URL) return res.status(503).json({ error: "The music studio isn't set up (STUDIO_URL); start it with docker compose" });
  if (req.method !== "GET" && HARNESS_TOKEN && req.headers.authorization !== `Bearer ${HARNESS_TOKEN}`) return res.status(401).json({ error: "Missing or invalid bearer token" });
  const isFile = sub.startsWith("/files/");
  // A file stream (an audio player) lives as long as the browser keeps it open: it's cancelled when
  // the browser lets go (seeking, pausing, leaving the page), never on a timer mid-stream
  const gone = new AbortController();
  res.on("close", () => gone.abort());
  try {
    const r = await fetch(`${STUDIO_URL}${sub}`, {
      method: req.method,
      headers: { "Content-Type": "application/json", ...(req.headers.range ? { Range: String(req.headers.range) } : {}) },
      body: req.method === "GET" ? undefined : JSON.stringify(req.body ?? {}),
      // An upload is converted before the answer comes back
      signal: isFile ? gone.signal : AbortSignal.any([gone.signal, AbortSignal.timeout(req.method === "POST" && (sub === "/songs" || sub === "/media") ? 10 * 60_000 : 30_000)]),
    });
    if (isFile) {
      res.status(r.status);
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const v = r.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (/(^|&)download=1(&|$)/.test(query)) res.setHeader("Content-Disposition", `attachment; filename="${sub.split("/").pop()!.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
      if (!r.body) return res.end();
      const { Readable, pipeline } = await import("node:stream");
      // pipeline() handles a cancelled or broken stream; a bare pipe() would leave the error
      // unhandled and take the whole harness down
      pipeline(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream), res, () => {});
      return;
    }
    const data = await r.json().catch(() => ({ error: `The studio answered ${r.status}` }));
    if (req.method === "POST" && r.ok && sub === "/jobs") hive.log("studio", "job", String((data as { title?: string }).title ?? "studio job"));
    if (req.method === "POST" && r.ok && sub === "/songs") hive.log("studio", "song", `added “${String((data as { title?: string }).title ?? "a song")}”`);
    res.status(r.status).json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(502).json({ error: /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg) ? "The music studio isn't answering (docker compose up -d studio)" : msg });
  }
});

// --- Niche research (src/hq/research.ts) -----------------------------------------------
const research = new ResearchStore(path.join(DATA_DIR, "research"));
const researchQueue: string[] = [];
let researchBusy = false;
/** What each running research is doing now, for the Books page */
const researchProgress = new Map<string, string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Etsy research needs your app's API key (etsy.com/developers): the keystring and the shared secret
const ETSY_KEY = process.env.ETSY_API_KEY?.trim() ? etsyKeyHeader(process.env.ETSY_API_KEY.trim(), process.env.ETSY_SHARED_SECRET?.trim()) : "";

async function runResearch(r: Research) {
  const save = () => research.get(r.id) === r && research.save(r);
  r.status = "mining";
  save();
  if (r.market === "etsy") {
    if (!ETSY_KEY) throw new Error("Etsy research needs an Etsy API key: set ETSY_API_KEY and ETSY_SHARED_SECRET in .env (free from etsy.com/developers), then restart.");
    const got = await mineEtsy(r.seed, ETSY_KEY, { delayMs: 300, onProgress: (t) => researchProgress.set(r.id, t) });
    r.keywords = got.keywords;
    if (got.failed) r.notes.push(`${got.failed} Etsy searches failed; the rest were used.`);
    if (!r.keywords.length) throw new Error("Etsy found nothing for this niche. Try broader words.");
    save();
    return finishResearch(r, save);
  }
  const mined = await mineKeywords(r.seed, r.market, { delayMs: 250, onProgress: (d, t) => researchProgress.set(r.id, `Reading Amazon's search suggestions (${d} of ${t})`) });
  r.keywords = mined.keywords;
  if (mined.failed) r.notes.push(`${mined.failed} of 27 suggestion requests failed; the rest were used.`);
  if (!r.keywords.length) throw new Error("Amazon suggested nothing for this niche. Try broader words.");
  save();
  if (BROWSER_CDP_URL) {
    r.status = "competition";
    save();
    const count = Math.min(COMPETITION_CHECKS, r.keywords.length);
    for (let i = 0; i < count; i++) {
      const k = r.keywords[i];
      researchProgress.set(r.id, `Reading the first page of results for “${k.text}” (${i + 1} of ${count})`);
      let html: string;
      try {
        html = await renderPage(searchUrl(k.text, r.market), BROWSER_CDP_URL);
      } catch (e) {
        r.notes.push(`The browser couldn't open Amazon (${e instanceof Error ? e.message : e}); competition was read for ${i} phrases.`);
        break;
      }
      if (isBlockedPage(html)) {
        r.notes.push(`Amazon showed a robot check, so competition was read for ${i} of ${count} phrases. Try again later.`);
        break;
      }
      const listings = parseResults(html);
      if (!listings.length) r.notes.push(`No listings could be read for “${k.text}” (Amazon's page may have changed).`);
      else r.keywords[i] = { ...k, competition: competitionOf(listings) };
      r.keywords = scoreKeywords(r.keywords);
      save();
      // Paced like a person reading, so Amazon is less likely to show a robot check
      await sleep(1500 + Math.random() * 1500);
    }
  } else r.notes.push("Competition wasn't checked: it needs the browser sidecar (BROWSER_CDP_URL).");
  return finishResearch(r, save);
}

/** The last stage: the Writer turns the numbers into book ideas. */
async function finishResearch(r: Research, save: () => unknown) {
  r.status = "thinking";
  save();
  // The Writer's model shares the GPU: wait for the running card or book step to finish
  researchProgress.set(r.id, "Waiting for the model to be free…");
  for (let waited = 0; (runningTaskId || backgroundBusy) && waited < 20 * 60_000; waited += 2000) await sleep(2000);
  researchProgress.set(r.id, "The Writer is turning the numbers into book ideas…");
  backgroundBusy = true;
  try {
    const out = await inProject(r.project, () => gateway.json("writer", conceptsPrompt(r), (note) => hive.log("writer", "policy", note)));
    const parsed = parseConcepts(out.json ?? {});
    if ("error" in parsed) throw new Error(parsed.error);
    r.concepts = parsed.concepts;
    r.summary = parsed.summary;
  } finally {
    backgroundBusy = false;
    void pump();
  }
  r.status = "done";
  hive.log("writer", "research", `niche “${r.seed}”: ${r.keywords.length} phrases, ${r.keywords.filter((k) => k.competition).length} checked, ${r.concepts?.length ?? 0} concepts`);
}

async function runResearchQueue() {
  if (researchBusy) return;
  const id = researchQueue.shift();
  if (!id) return;
  const r = research.get(id);
  if (!r) return void runResearchQueue();
  researchBusy = true;
  try {
    await runResearch(r);
  } catch (e) {
    r.status = "failed";
    r.error = (e instanceof Error ? e.message : String(e)).slice(0, 400);
  } finally {
    if (research.get(r.id) === r) research.save(r);
    researchProgress.delete(r.id);
    researchBusy = false;
    void runResearchQueue();
  }
}

const researchView = (r: Research) => ({ ...r, progress: researchProgress.get(r.id) ?? (researchQueue.includes(r.id) ? "Waiting for the research before it" : null) });

app.get("/api/research", (req, res) => {
  const p = typeof req.query.project === "string" && req.query.project !== "all" ? projects.idOf(req.query.project === "general" ? null : req.query.project) : undefined;
  res.json({ items: research.list(p).map(researchView), browser: Boolean(BROWSER_CDP_URL), etsy: Boolean(ETSY_KEY) });
});

app.get("/api/research/:id", (req, res) => {
  const r = research.get(String(req.params.id));
  if (!r) return res.status(404).json({ error: "Research not found" });
  res.json(researchView(r));
});

app.post("/api/research", requireToken, (req, res) => {
  const r = newResearch(req.body ?? {});
  if ("error" in r) return res.status(400).json(r);
  if (r.project && !projects.get(r.project)) return res.status(400).json({ error: "Unknown project" });
  research.save(r);
  researchQueue.push(r.id);
  void runResearchQueue();
  res.status(201).json(researchView(r));
});

app.delete("/api/research/:id", requireToken, (req, res) => {
  const id = String(req.params.id);
  if (researchProgress.has(id)) return res.status(409).json({ error: "Wait for this research to finish" });
  const i = researchQueue.indexOf(id);
  if (i >= 0) researchQueue.splice(i, 1);
  if (!research.delete(id)) return res.status(404).json({ error: "Research not found" });
  res.json({ ok: true });
});

app.delete("/api/books/:id", requireToken, (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  if (isRunning(b)) bookRun!.controller.abort();
  books.delete(b.id);
  res.json({ ok: true });
});

app.get("/api/books/:id/export/:fmt", (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  const fmt = String(req.params.fmt);
  if (!b.chapters.some((c) => c.text)) return res.status(400).json({ error: "No chapters are written yet" });
  const out =
    fmt === "epub"
      ? { type: "application/epub+zip", body: bookEpub(b, bookCover(b), bookImage) }
      : fmt === "md"
        ? { type: "text/markdown; charset=utf-8", body: Buffer.from(bookMarkdown(b)) }
        : fmt === "html"
          ? { type: "text/html; charset=utf-8", body: Buffer.from(bookHtml(b, { trim: (req.query.trim as Trim) || trimOf(b), image: bookImageUri })) }
          : null;
  if (!out) return res.status(400).json({ error: "Formats: epub, md, html" });
  res.setHeader("Content-Type", out.type);
  res.setHeader("Content-Disposition", `attachment; filename="${bookFileName(b, fmt)}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // The HTML is a download, never a page that runs in Mission Control's origin
  if (fmt === "html") res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  res.end(out.body);
});

/** A print-ready PDF (6×9 in by default), saved with the other files. */
app.post("/api/books/:id/pdf", requireToken, async (req, res) => {
  const b = bookOr404(req, res);
  if (!b) return;
  if (!BROWSER_CDP_URL) return res.status(400).json({ error: "PDFs are printed by the browser sidecar: set BROWSER_CDP_URL (see README-HQ)" });
  if (!b.chapters.some((c) => c.text)) return res.status(400).json({ error: "No chapters are written yet" });
  const trim = (typeof req.body?.trim === "string" && req.body.trim in TRIMS ? req.body.trim : trimOf(b)) as Trim;
  const cover = bookCover(b);
  try {
    const html = bookHtml(b, { trim, cover: cover ? `data:${cover.mime};base64,${cover.data.toString("base64")}` : undefined, image: bookImageUri });
    const pdf = await printPdf(html, BROWSER_CDP_URL, { footer: b.kind === "picture" ? "none" : "number" });
    const saved = files.save(b.title || "book", pdf);
    res.json({ ...saved, url: `/api/files/${saved.name}` });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- Asset dictionary, brand and voices (for videos) --------------------------

/** Sends bytes, answering byte-range requests so audio and video can seek. */
function sendBytes(req: Request, res: Response, buf: Buffer, type: string) {
  res.setHeader("Content-Type", type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, buf.length - Number(range[2]));
    const end = Math.min(range[1] && range[2] ? Number(range[2]) : buf.length - 1, buf.length - 1);
    if (start > end || start >= buf.length) {
      res.setHeader("Content-Range", `bytes */${buf.length}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${buf.length}`);
    res.setHeader("Content-Length", String(end - start + 1));
    return res.end(buf.subarray(start, end + 1));
  }
  res.setHeader("Content-Length", String(buf.length));
  res.end(buf);
}

const beatJobs = new Set<string>();
/** Finds a music asset's beats with the voice service (in the background). */
async function findBeats(id: string): Promise<string | null> {
  const buf = assets.bytes(id);
  if (!voice || !buf) return "No voice service is set up (VOICE_URL)";
  if (beatJobs.has(id)) return null;
  beatJobs.add(id);
  try {
    const out = await voice.beats(buf);
    if ("error" in out) return out.error;
    const a = assets.get(id);
    assets.update(id, { tempo: out.tempo, beats: out.beats, seconds: a?.seconds ?? out.seconds });
    return null;
  } finally {
    beatJobs.delete(id);
  }
}

app.get("/api/assets", async (req, res) => {
  const h = voice ? await voice.health() : null;
  const ids = h?.voices?.length ? h.voices : Object.keys(KNOWN_VOICES);
  const p = projectParam(req.query.project);
  const project = p ?? null;
  res.json({
    assets: p === undefined ? assets.list() : assets.list().filter((a) => visibleIn(a.project, p)),
    brand: assets.brand(project),
    ownBrand: project ? assets.hasOwnBrand(project) : true,
    fonts: SYSTEM_FONTS,
    voices: ids.map((id) => ({ id, label: KNOWN_VOICES[id] ?? id })),
    voice: !voice ? "off" : !h ? "down" : h.ready ? (h.error ? "partial" : "ready") : "loading",
    voiceError: h?.error ?? null,
    whisper: h?.whisper ?? null,
  });
});

app.post("/api/assets", requireToken, (req, res) => {
  const parsed = AssetUploadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const out = assets.add(parsed.data);
  if ("error" in out) return res.status(400).json(out);
  if (out.role === "music" && voice) void findBeats(out.id).catch(() => {});
  res.json(out);
});

// The Gallery: pictures and clips the cards made, and adding one to the asset dictionary
app.get("/api/gallery", (req, res) => {
  res.json({ items: galleryItems(files.list(), tasks.values(), assets.list(), projectParam(req.query.project)) });
});

app.post("/api/gallery/:name/asset", requireToken, (req, res) => {
  const name = String(req.params.name);
  if (!FILE_ID.test(name) || !galleryKind(name)) return res.status(404).json({ error: "That isn't a picture or clip in the gallery" });
  const existing = assets.list().find((a) => a.source === name);
  if (existing) return res.json(existing);
  const parsed = AssetInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const buf = files.read(name);
  if (!buf) return res.status(404).json({ error: "File not found" });
  const out = assets.add({ ...parsed.data, data: buf.toString("base64") }, name);
  if ("error" in out) return res.status(400).json(out);
  res.json(out);
});

app.patch("/api/assets/:id", requireToken, (req, res) => {
  const parsed = AssetPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const out = assets.update(String(req.params.id), parsed.data);
  if (!out) return res.status(404).json({ error: "Asset not found" });
  res.json(out);
});

app.delete("/api/assets/:id", requireToken, (req, res) => {
  if (!assets.remove(String(req.params.id))) return res.status(404).json({ error: "Asset not found" });
  res.json({ ok: true, brand: assets.brand() });
});

app.get("/api/assets/:id/file", (req, res) => {
  const a = assets.get(String(req.params.id));
  const buf = a ? assets.bytes(a.id) : null;
  if (!a || !buf) return res.status(404).json({ error: "Asset not found" });
  // An SVG opened on its own can't run scripts here
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox");
  res.setHeader("Cache-Control", "private, max-age=3600");
  sendBytes(req, res, buf, a.mime);
});

app.post("/api/assets/:id/beats", requireToken, async (req, res) => {
  const a = assets.get(String(req.params.id));
  if (!a) return res.status(404).json({ error: "Asset not found" });
  if (a.kind !== "audio") return res.status(400).json({ error: "Only music has beats" });
  const err = await findBeats(a.id);
  if (err) return res.status(400).json({ error: err });
  res.json(assets.get(a.id));
});

// ?project=<id>: that project's own brand (otherwise the General brand)
app.put("/api/brand", requireToken, (req, res) => {
  const out = assets.setBrand(req.body, projectParam(req.query.project) ?? null);
  if ("error" in out) return res.status(400).json(out);
  res.json(out);
});
// A project goes back to the General brand
app.delete("/api/brand", requireToken, (req, res) => {
  const p = projectParam(req.query.project);
  if (!p) return res.status(400).json({ error: "Say which project (?project=<id>)" });
  assets.clearBrand(p);
  res.json(assets.brand(null));
});

// --- Model presets ---------------------------------------------------------------

app.get("/api/presets", (_req, res) => {
  res.json({ presets: models.presets(), active: models.activePreset()?.id ?? null });
});
// { name } saves the team's current setup; { name, models } saves those models
app.post("/api/presets", requireToken, (req, res) => {
  const out = models.savePreset(String(req.body?.name ?? ""), req.body?.models);
  if ("error" in out) return res.status(400).json(out);
  hive.log("models", "preset saved", out.name);
  res.status(201).json(out);
});
app.patch("/api/presets/:id", requireToken, (req, res) => {
  const cur = models.preset(String(req.params.id));
  if (!cur) return res.status(404).json({ error: "Preset not found" });
  const out = models.savePreset(String(req.body?.name ?? cur.name), req.body?.fromCurrent ? undefined : (req.body?.models ?? cur.models), cur.id);
  if ("error" in out) return res.status(400).json(out);
  res.json(out);
});
app.delete("/api/presets/:id", requireToken, (req, res) => {
  const id = String(req.params.id);
  const users = projects.list().filter((p) => p.preset === id);
  if (users.length) return res.status(409).json({ error: `Used by the project${users.length > 1 ? "s" : ""} ${users.map((p) => `“${p.name}”`).join(", ")}` });
  if (!models.removePreset(id)) return res.status(404).json({ error: models.preset(id)?.builtIn ? "Built-in presets can't be deleted" : "Preset not found" });
  res.json({ ok: true });
});
app.post("/api/presets/:id/apply", requireToken, (req, res) => {
  const id = String(req.params.id);
  if (!models.preset(id)) return res.status(404).json({ error: "Preset not found" });
  const out = models.applyPreset(id);
  if ("error" in out) return res.status(400).json(out);
  hive.log("models", "preset", models.preset(id)!.name);
  res.json(out);
});

// --- Change history and workspaces ----------------------------------------------

const changeView = (c: ReturnType<Changes["list"]>[number]) => ({
  ...c,
  where: rootLabel(c.root),
  taskTitle: c.taskId ? (tasks.get(c.taskId)?.title ?? store.find(c.taskId)?.title) : undefined,
});

app.get("/api/changes", (req, res) => {
  const list = changes.list({ project: projectParam(req.query.project), taskId: typeof req.query.task === "string" ? req.query.task : undefined, limit: Number(req.query.limit) || 100 });
  res.json(list.map(changeView));
});
app.get("/api/changes/:id", (req, res) => {
  const d = changes.detail(String(req.params.id));
  if (!d) return res.status(404).json({ error: "Change not found" });
  res.json({ ...changeView(d), files: d.files, conflicts: d.undoneBy ? [] : changes.conflicts(d) });
});
// Undo (or redo, for an undo). Files changed since need { force: true }.
app.post("/api/changes/:id/undo", requireToken, (req, res) => {
  const set = changes.get(String(req.params.id));
  if (!set) return res.status(404).json({ error: "Change not found" });
  const running = set.taskId ? tasks.get(set.taskId) : undefined;
  if (running && RUNNING_STATUSES.includes(running.status)) return res.status(409).json({ error: "Wait for the card to finish" });
  const out = changes.undo(set.id, req.body?.force === true);
  if ("conflicts" in out) return res.status(409).json({ error: `Changed since: ${out.conflicts.join(", ")}. Undo anyway?`, conflicts: out.conflicts });
  if ("error" in out) return res.status(400).json(out);
  const t = set.taskId ? tasks.get(set.taskId) : undefined;
  if (t) {
    t.changes = [...(t.changes ?? []), out.set.id];
    store.save(t);
  }
  hive.log("changes", out.set.label.startsWith("Redo") ? "redo" : "undo", `${set.label} (${set.files.length} file${set.files.length > 1 ? "s" : ""} in ${rootLabel(set.root)})`, set.taskId);
  res.json(changeView(out.set));
});

app.get("/api/workspace", (req, res) => {
  const p = projectParam(req.query.project) ?? null;
  const ws = workspaceOf(p);
  const { files, truncated } = ws.tree(2000);
  res.json({ name: ws.name, root: ws.root, exists: ws.exists(), files, truncated });
});
app.get("/api/workspace/file", (req, res) => {
  const ws = workspaceOf(projectParam(req.query.project) ?? null);
  const r = ws.read(String(req.query.path ?? ""));
  if ("error" in r) return res.status(400).json(r);
  if (r.text === null) return res.status(404).json({ error: "No such file" });
  res.json({ path: String(req.query.path), text: r.text });
});

// --- Projects ---------------------------------------------------------------

/** Memories per project; empty if the memory store is unreachable (the counts are only shown) */
async function memoryCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    for (const m of await memory.list()) if (m.project) counts.set(m.project, (counts.get(m.project) ?? 0) + 1);
  } catch {
    // shown as 0
  }
  return counts;
}

function projectView(p: ReturnType<Projects["list"]>[number], memCounts: Map<string, number>) {
  const cards = [...tasks.values()].filter((t) => !t.parentId && t.project === p.id);
  return {
    ...p,
    counts: {
      cards: cards.length,
      open: cards.filter((t) => !TERMINAL_STATUSES.includes(t.status)).length,
      memories: memCounts.get(p.id) ?? 0,
      skills: skills.list().filter((s) => s.project === p.id).length,
      assets: assets.countIn(p.id),
      routines: scheduler.list().filter((r) => r.project === p.id).length,
    },
    ownBrand: assets.hasOwnBrand(p.id),
  };
}

app.get("/api/projects", async (_req, res) => {
  const counts = await memoryCounts();
  res.json({ projects: projects.list().map((p) => projectView(p, counts)) });
});
app.post("/api/projects", requireToken, async (req, res) => {
  const bad = (req.body?.profiles ?? []).find?.((n: unknown) => typeof n === "string" && !profiles.exists(n));
  if (bad) return res.status(400).json({ error: `There's no browser profile called “${bad}”` });
  if (typeof req.body?.preset === "string" && !models.preset(req.body.preset)) return res.status(400).json({ error: "Unknown model preset" });
  const out = projects.create(req.body);
  if ("error" in out) return res.status(400).json(out);
  hive.log("projects", "created", out.name);
  res.status(201).json(projectView(out, await memoryCounts()));
});
app.patch("/api/projects/:id", requireToken, async (req, res) => {
  const bad = (req.body?.profiles ?? []).find?.((n: unknown) => typeof n === "string" && !profiles.exists(n));
  if (bad) return res.status(400).json({ error: `There's no browser profile called “${bad}”` });
  if (typeof req.body?.preset === "string" && !models.preset(req.body.preset)) return res.status(400).json({ error: "Unknown model preset" });
  const before = projects.get(String(req.params.id));
  const out = projects.update(String(req.params.id), req.body);
  if ("error" in out) return res.status(out.error === "Project not found" ? 404 : 400).json(out);
  if (before && JSON.stringify(req.body?.profiles ?? null) !== "null") hive.log("projects", "updated", `${out.name}: sign-ins ${out.profiles.join(", ") || "none"}`);
  res.json(projectView(out, await memoryCounts()));
});
// Deleting needs an empty project (move or remove its cards, assets, skills and routines first,
// or archive it instead). Its memories and own brand go with it.
app.delete("/api/projects/:id", requireToken, async (req, res) => {
  const p = projects.get(String(req.params.id));
  if (!p) return res.status(404).json({ error: "Project not found" });
  const v = projectView(p, await memoryCounts());
  const left = [
    v.counts.cards && `${v.counts.cards} card${v.counts.cards > 1 ? "s" : ""}`,
    v.counts.assets && `${v.counts.assets} asset${v.counts.assets > 1 ? "s" : ""}`,
    v.counts.skills && `${v.counts.skills} skill${v.counts.skills > 1 ? "s" : ""}`,
    v.counts.routines && `${v.counts.routines} routine${v.counts.routines > 1 ? "s" : ""}`,
  ].filter(Boolean);
  if (left.length) return res.status(409).json({ error: `“${p.name}” still has ${left.join(", ")}. Move or delete them first, or archive the project.` });
  let forgot = 0;
  try {
    forgot = await memory.removeProject(p.id);
  } catch (e) {
    return res.status(503).json({ error: `Couldn't remove the project's memories: ${e instanceof Error ? e.message : String(e)}` });
  }
  changes.moveProject(p.id, null);
  assets.clearBrand(p.id);
  projects.remove(p.id);
  hive.log("projects", "deleted", `${p.name}${forgot ? ` and ${forgot} memories` : ""}`);
  res.json({ ok: true, memories: forgot });
});

// Tools: what the tools service offers, and a way to try one (read-only tools only for now)
app.get("/api/tools", async (req, res) => {
  if (!tools) return res.json({ enabled: false, servers: [] });
  try {
    const servers = await tools.list(req.query.fresh === "1");
    if (req.query.fresh === "1") void refreshToolsSummary();
    res.json({ enabled: true, servers });
  } catch (e) {
    res.json({ enabled: true, servers: [], error: e instanceof Error ? e.message : String(e) });
  }
});
app.post("/api/tools/call", requireToken, async (req, res) => {
  if (!tools) return res.status(400).json({ error: "No tools service is set up (TOOLS_URL)" });
  const server = typeof req.body?.server === "string" ? req.body.server : "";
  const tool = typeof req.body?.tool === "string" ? req.body.tool : "";
  const args = req.body?.args && typeof req.body.args === "object" && !Array.isArray(req.body.args) ? (req.body.args as Record<string, unknown>) : {};
  if (!server || !tool) return res.status(400).json({ error: "server and tool are required" });
  try {
    const out = await tools.call(server, tool, args);
    hive.log("tools", "call", `${server}.${tool} (tried from the dashboard)${out.isError ? ": failed" : ""}`);
    res.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(/changes things/.test(msg) ? 403 : /^No tool /.test(msg) ? 404 : 502).json({ error: msg });
  }
});

// Try a voice: speaks a short line and returns the WAV
app.post("/api/voice/preview", requireToken, async (req, res) => {
  if (!voice) return res.status(400).json({ error: "No voice service is set up (VOICE_URL)" });
  const body = (req.body ?? {}) as { text?: unknown; voice?: unknown; speed?: unknown };
  const text = (typeof body.text === "string" && body.text.trim() ? body.text.trim() : "Hi! This is how I'll sound in your videos.").slice(0, 300);
  const who = typeof body.voice === "string" && /^[a-z]{2}_[a-z0-9]+$/.test(body.voice) ? body.voice : assets.brand().voice;
  const speed = Math.min(1.6, Math.max(0.6, Number(body.speed) || 1));
  const out = await voice.speak(text, who, speed, AbortSignal.timeout(120_000));
  if ("error" in out) return res.status(502).json(out);
  res.setHeader("X-Voice", out.voice);
  sendBytes(req, res, out.wav, "audio/wav");
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
  res.setHeader("Content-Type", fileType(name));
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${name}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  // Video players ask for byte ranges so they can seek
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, file.length - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : file.length - 1;
    end = Math.min(end, file.length - 1);
    if (start > end || start >= file.length) {
      res.setHeader("Content-Range", `bytes */${file.length}`);
      return res.status(416).end();
    }
    start = Math.max(0, start);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${file.length}`);
    res.setHeader("Content-Length", String(end - start + 1));
    return res.end(file.subarray(start, end + 1));
  }
  res.setHeader("Content-Length", String(file.length));
  res.end(file);
});

app.post("/api/tasks/:id/accept", requireToken, (req, res) => {
  const task = tasks.get(String(req.params.id));
  if (!task || task.status !== "complete") return res.status(400).json({ error: "Only finished cards can be accepted" });
  if (task.plan?.status === "awaiting") return res.status(400).json({ error: "This card's plan is waiting for your review: approve it or send it back from the Inbox" });
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
  questions.dropTask(task.id);
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
/** ?project=: "all" or missing → undefined (everything), "general" → null, or a project id. */
function projectParam(q: unknown): string | null | undefined {
  if (q === undefined || q === "all" || q === "") return undefined;
  if (q === "general") return null;
  return projects.idOf(String(q));
}

app.get("/api/hive", (req, res) => {
  res.json(hive.recent(Math.min(Number(req.query.limit) || 100, 500), projectParam(req.query.project)));
});
app.get("/api/memories", async (req, res) => {
  const p = projectParam(req.query.project);
  try {
    const all = await memory.list();
    res.json(p === undefined ? all : all.filter((m) => visibleIn(m.project, p)));
  } catch (e) {
    res.status(503).json({ error: `Memory unavailable: ${e instanceof Error ? e.message : String(e)}` });
  }
});
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

app.post("/api/memories", requireToken, async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const project = typeof req.body?.project === "string" ? projects.idOf(req.body.project) : null;
  // Typed by you, so private unless you say otherwise ("private": false lets cloud models see it)
  const id = await memory.add(text, "shared", 0.7, req.body?.pinned !== false, req.body?.private !== false, project);
  if (id === null) return res.status(400).json({ error: "Memory text is too short" });
  res.status(201).json({ id });
});
app.post("/api/memories/maintain", requireToken, async (_req, res) => res.json(await memory.maintain()));
app.post("/api/memories/:id/:action", requireToken, async (req, res) => {
  const id = String(req.params.id);
  const actions: Record<string, () => Promise<boolean>> = {
    pin: () => memory.setPinned(id, true),
    unpin: () => memory.setPinned(id, false),
    // "share" lets cloud models (and cloud MCP clients such as Claude Code) see it; "private" hides it again
    share: () => memory.setPrivate(id, false),
    private: () => memory.setPrivate(id, true),
    // "move" with {"project": "<id or name>"} or {"project": null} for General
    move: () => {
      const to = req.body?.project;
      if (typeof to !== "string" || !to || to === "general") return memory.setProject(id, null);
      const target = projects.idOf(to);
      // An unknown project mustn't quietly move it to General
      return target ? memory.setProject(id, target) : Promise.resolve(false);
    },
    delete: () => memory.remove(id),
  };
  const run = actions[String(req.params.action)];
  if (!run) return res.status(400).json({ error: "Unknown action" });
  const ok = await run();
  res.status(ok ? 200 : 404).json({ ok });
});

// Legacy routes from the earlier harness (voice Jarvis and old clients)
app.get("/stream", handleStream);
app.post("/command", requireToken, (req, res) => enqueue(req.body, res));
app.post("/cancel", requireToken, (req, res) => cancel(req.body?.taskId, res));

// --- Skills and history search API ----------------------------------------------
app.get("/api/skills", (_req, res) => {
  res.json({ skills: skills.list(), auto: autoSkills() });
});
app.post("/api/skills", requireToken, (req, res) => {
  // Skills you write yourself are on straight away
  const out = skills.create(req.body, { status: "active" });
  if ("error" in out) return res.status(400).json(out);
  hive.log("skills", "added", out.name);
  res.status(201).json(out);
});
app.patch("/api/skills/:id", requireToken, (req, res) => {
  const out = skills.update(String(req.params.id), req.body);
  if ("error" in out) return res.status(out.error === "Skill not found" ? 404 : 400).json(out);
  if (req.body?.status === "active") hive.log("skills", "approved", out.name);
  res.json(out);
});
app.post("/api/skills/:id/approve", requireToken, (req, res) => {
  const out = skills.approve(String(req.params.id));
  if ("error" in out) return res.status(out.error === "Skill not found" ? 404 : 400).json(out);
  hive.log("skills", "approved", out.name);
  res.json(out);
});
app.delete("/api/skills/:id", requireToken, (req, res) => {
  if (!skills.remove(String(req.params.id))) return res.status(404).json({ error: "Skill not found" });
  res.json({ ok: true });
});
app.put("/api/skills/settings", requireToken, (req, res) => {
  store.setSetting("autoSkills", req.body?.auto !== false);
  res.json({ auto: autoSkills() });
});
// Draft a skill from a finished card now
app.post("/api/tasks/:id/skill", requireToken, async (req, res) => {
  const task = tasks.get(String(req.params.id));
  if (!task || task.parentId) return res.status(404).json({ error: "Task not found" });
  if (!TERMINAL_STATUSES.includes(task.status)) return res.status(400).json({ error: "Wait for the card to finish" });
  try {
    const out = await inProject(task.project, () => draftSkill(task));
    if ("error" in out) return res.status(422).json(out);
    res.status(201).json(out);
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/tasks/:id/restore", requireToken, (req, res) => {
  const t = store.restore(String(req.params.id));
  if (!t) return res.status(404).json({ error: "No archived card with that id" });
  hive.log(t.targetAgent, "restored", t.title || t.prompt.slice(0, 80), t.id);
  res.json(summarize(t));
});

app.get("/api/search", (req, res) => {
  const q = String(req.query.q ?? "").slice(0, 200);
  const only = projectParam(req.query.project);
  const hits = historyIndex
    .search(q)
    .map((h) => {
      const t = store.find(h.taskId);
      if (!t) {
        historyIndex.remove(h.taskId);
        return null;
      }
      if (only !== undefined && (t.project ?? null) !== only) return null;
      return { ...h, status: t.status, createdAt: t.createdAt, archived: Boolean(t.archived), agent: t.targetAgent, project: t.project };
    })
    .filter(Boolean);
  res.json(hits);
});

// --- Decision Inbox -----------------------------------------------------------
/**
 * Sends a card the answers it's been waiting for, once it's finished and every question
 * it asked is answered or dismissed. Returns why not when it can't go yet.
 */
function deliverAnswers(task: Task): string | null {
  const ready = readyToDeliver(questions, task.id, TERMINAL_STATUSES.includes(task.status));
  if (!ready.length) return null;
  const err = replyTo(task, { message: answerMessage(ready), targetAgent: "same" });
  if (err) {
    hive.log("inbox", "not sent", `${err} (the answer waits on the card)`, task.id);
    return err;
  }
  questions.markDelivered(ready.map((q) => q.id));
  hive.log("inbox", "answered", ready.map((q) => `${q.question} → ${q.answer}`).join("; "), task.id);
  return null;
}

const INBOX_FINISHED_MS = 3 * 24 * 60 * 60_000;

app.get("/api/inbox", (_req, res) => {
  const top = [...tasks.values()].filter((t) => !t.parentId);
  const open = questions.open().filter((q) => tasks.has(q.taskId));
  const card = (t: Task) => ({
    id: t.id,
    title: t.title || t.prompt.slice(0, 80),
    agent: t.targetAgent,
    status: t.status,
    project: t.project,
    finishedAt: t.finishedAt,
    preview: (t.answer ?? t.error ?? "").slice(0, 280),
  });
  const plans = top
    .filter((t) => t.plan && (t.plan.status === "awaiting" || t.plan.status === "revising"))
    .map((t) => ({ ...card(t), kind: "plan" as const, plan: t.plan }));
  const reviews = top
    .filter((t) => t.status === "complete" && t.needsReview && !t.acceptedAt && t.plan?.status !== "awaiting" && t.plan?.status !== "revising")
    .map((t) => ({ ...card(t), kind: "result" as const }));
  const since = Date.now() - INBOX_FINISHED_MS;
  const finished = top
    .filter((t) => TERMINAL_STATUSES.includes(t.status) && (t.finishedAt ?? 0) >= since && boardColumn(t) !== "review")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 20)
    .map(card);
  const waitingOnYou = open.length + plans.filter((p) => p.plan?.status === "awaiting").length + reviews.length + approvals.pending().length;
  res.json({
    questions: open.map((q) => ({ ...q, taskStatus: tasks.get(q.taskId)?.status })),
    review: [...plans, ...reviews].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0)),
    finished,
    approvals: approvals.pending().length,
    answered: questions.recent(10),
    count: waitingOnYou,
  });
});

app.post("/api/inbox/questions/:id", requireToken, (req, res) => {
  const parsed = QuestionAnswerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "An answer is needed" });
  const q = questions.answer(String(req.params.id), parsed.data.answer, parsed.data.note);
  if (!q) return res.status(409).json({ error: "That question isn't waiting any more" });
  const task = tasks.get(q.taskId);
  if (!task) return res.json({ ok: true, delivered: false, reason: "The card is no longer on the board" });
  const err = deliverAnswers(task);
  const delivered = !questions.undelivered(task.id).length;
  res.json({
    ok: true,
    delivered,
    reason: delivered
      ? undefined
      : err ?? (TERMINAL_STATUSES.includes(task.status) ? "It goes back once you answer the card's other question" : "The card is busy; it gets your answer as soon as it finishes"),
  });
});

app.post("/api/inbox/questions/:id/dismiss", requireToken, (req, res) => {
  const q = questions.get(String(req.params.id));
  if (!q || !questions.dismiss(q.id)) return res.status(409).json({ error: "That question isn't waiting any more" });
  // Other answers on that card may have been waiting for this one
  const task = tasks.get(q.taskId);
  if (task) deliverAnswers(task);
  res.json({ ok: true });
});

// --- Plan Markup ---------------------------------------------------------------
app.post("/api/tasks/:id/plan", requireToken, (req, res) => {
  const task = tasks.get(String(req.params.id));
  if (!task || task.parentId) return res.status(404).json({ error: "Task not found" });
  if (!task.plan || task.plan.status !== "awaiting") return res.status(409).json({ error: "This card has no plan waiting for review" });
  const parsed = PlanReviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid review" });
  const r = parsed.data;
  if (r.version !== undefined && r.version !== task.plan.version) return res.status(409).json({ error: `There's a newer plan (version ${task.plan.version}); reload it before reviewing` });
  const plan = task.plan;
  const annotations = cleanAnnotations(plan.text, r.annotations);
  const dropped = r.annotations.length - annotations.length;
  const message = reviewMessage(plan.text, annotations, r.decision, r.note);
  const lastReview = { decision: r.decision, annotations, ...(r.note ? { note: r.note } : {}), at: Date.now() };
  // The approved text (your cuts and replacements made) is what the card works from
  task.plan =
    r.decision === "approve"
      ? { ...plan, status: "approved", text: applyAnnotations(plan.text, annotations), lastReview }
      : { ...plan, status: "revising", lastReview };
  const err = replyTo(task, { message, targetAgent: "same" });
  if (err) {
    task.plan = plan;
    store.save(task);
    return res.status(400).json({ error: err });
  }
  store.save(task);
  hive.log("plan", r.decision === "approve" ? "approved" : "revise", `v${plan.version}: ${annotations.length} mark(s)`, task.id);
  // Cards waiting on this one may run once its work is done, not before
  res.json({ ...summarize(task), dropped });
});

// --- Approvals API -----------------------------------------------------------
app.get("/api/approvals", (_req, res) => {
  const pending = approvals.pending().map((a) => ({ ...a, summary: describeAction(a) }));
  const history = store.approvalLog<Approval>(40).map((a) => ({ ...a, summary: describeAction(a) }));
  // Agents waiting for you to take over their browser
  const handoffs = [...liveBrowsers.values()]
    .filter((b) => b.control.state === "user" && b.control.requestedBy === "agent")
    .map((b) => ({ id: b.id, taskTitle: b.title, reason: b.control.reason, since: b.control.since, expiresAt: (b.control.since ?? Date.now()) + TAKEOVER_TIMEOUT_MS }));
  res.json({ pending, history, policy: approvals.policy, handoffs });
});
app.get("/api/approvals/:id/screenshot", (req, res) => {
  const shot = approvals.screenshot(String(req.params.id));
  if (!shot) return res.status(404).json({ error: "No screenshot" });
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(Buffer.from(shot, "base64"));
});
app.post("/api/approvals/:id", requireToken, (req, res) => {
  const approve = req.body?.approve === true;
  const scope = req.body?.scope === "card" ? "card" : "once";
  const note = typeof req.body?.note === "string" ? req.body.note : undefined;
  if (!approvals.decide(String(req.params.id), approve, "you", scope, note)) return res.status(409).json({ error: "That request isn't waiting any more" });
  res.json({ ok: true });
});
app.put("/api/approvals/policy", requireToken, (req, res) => {
  const parsed = ApprovalPolicySchema.safeParse({ ...approvals.policy, ...(req.body ?? {}) });
  if (!parsed.success) return res.status(400).json({ error: "Invalid approval settings" });
  approvals.policy = parsed.data;
  store.setSetting("approvalPolicy", parsed.data);
  hive.log("approval", "settings", JSON.stringify(parsed.data));
  res.json(parsed.data);
});

// --- Browser profiles and take over API -----------------------------------------
app.get("/api/profiles", (_req, res) => {
  res.json({
    profiles: profiles.list().map((p) => ({ ...p, open: liveBrowsers.has(`manual-${p.name}`), project: projects.ownerOfProfile(p.name)?.id ?? null })),
    default: defaultProfile(),
    encrypted: Boolean(process.env.PROFILE_SECRET),
  });
});
app.post("/api/profiles", requireToken, (req, res) => {
  const name = String(req.body?.name ?? "").trim().toLowerCase();
  const err = profiles.create(name);
  if (err) return res.status(400).json({ error: err });
  hive.log("browser", "profile", `created “${name}”`);
  res.status(201).json(profiles.info(name));
});
app.put("/api/profiles/default", requireToken, (req, res) => {
  const name = String(req.body?.name ?? "");
  if (!profiles.exists(name)) return res.status(404).json({ error: "Profile not found" });
  store.setSetting("defaultProfile", name);
  res.json({ default: name });
});
app.delete("/api/profiles/:name", requireToken, async (req, res) => {
  const name = String(req.params.name);
  if (name === defaultProfile()) return res.status(400).json({ error: "That's the default profile: pick another default first" });
  if ([...liveBrowsers.values()].some((b) => b.profile === name && !b.manual)) return res.status(409).json({ error: "A running card is using it" });
  const open = liveBrowsers.get(`manual-${name}`);
  if (open) {
    liveBrowsers.delete(open.id);
    await open.session.close();
    broadcastBrowser({ type: "end", taskId: open.id });
  }
  if (!profiles.remove(name)) return res.status(404).json({ error: "Profile not found" });
  projects.dropProfile(name);
  hive.log("browser", "profile", `deleted “${name}” and its sign-ins`);
  res.json({ ok: true });
});
app.post("/api/profiles/:name/open", requireToken, async (req, res) => {
  const url = typeof req.body?.url === "string" && req.body.url.trim() ? req.body.url.trim() : undefined;
  try {
    const out = await openProfileWindow(String(req.params.name), url);
    if ("error" in out) return res.status(400).json(out);
    res.status(201).json({ id: out.id });
  } catch (e) {
    res.status(502).json({ error: `The browser couldn't open: ${e instanceof Error ? e.message : String(e)}` });
  }
});

app.get("/api/browser/sessions", (_req, res) => {
  res.json(
    [...liveBrowsers.values()].map((b) => ({
      id: b.id,
      taskId: b.taskId,
      title: b.title,
      profile: b.profile,
      readOnly: b.readOnly,
      manual: b.manual,
      control: b.control.state,
      by: b.control.requestedBy,
      reason: b.control.reason,
      url: b.session.url,
    })),
  );
});
const liveOr404 = (req: Request, res: Response): LiveBrowser | null => {
  const lb = liveBrowsers.get(String(req.params.id));
  if (!lb) res.status(404).json({ error: "That browser isn't open any more" });
  return lb ?? null;
};
app.post("/api/browser/:id/takeover", requireToken, (req, res) => {
  const lb = liveOr404(req, res);
  if (!lb) return;
  if (lb.readOnly) return res.status(400).json({ error: "Read-only runs can't be taken over: they never sign in or type" });
  lb.control.takeOver("user");
  lb.lastInputAt = Date.now();
  if (lb.taskId) hive.log("browser", "takeover", "you took over the browser", lb.taskId);
  res.json({ control: lb.control.state });
});
app.post("/api/browser/:id/handback", requireToken, async (req, res) => {
  const lb = liveOr404(req, res);
  if (!lb) return;
  if (lb.manual) return res.status(400).json({ error: "This is your own profile window: use Close & save" });
  lb.control.handBack();
  res.json({ control: lb.control.state });
});
app.post("/api/browser/:id/close", requireToken, async (req, res) => {
  const lb = liveOr404(req, res);
  if (!lb) return;
  if (!lb.manual) return res.status(400).json({ error: "A card's browser closes when the card ends: hand it back instead" });
  await closeProfileWindow(lb);
  res.json({ ok: true });
});
// Your clicks, typing and scrolling, only while you have control
app.post("/api/browser/:id/input", requireToken, async (req, res) => {
  const lb = liveOr404(req, res);
  if (!lb) return;
  if (lb.control.state !== "user") return res.status(409).json({ error: "Take over first" });
  lb.lastInputAt = Date.now();
  const b = req.body ?? {};
  try {
    if (b.type === "click" && Number.isFinite(b.x) && Number.isFinite(b.y)) await lb.session.userClick(b.x, b.y);
    else if (b.type === "type" && typeof b.text === "string") await lb.session.userType(b.text);
    else if (b.type === "key" && typeof b.key === "string") await lb.session.userKey(b.key);
    else if (b.type === "scroll" && Number.isFinite(b.dy)) await lb.session.userScroll(b.dy);
    else if (b.type === "navigate" && typeof b.url === "string") await lb.session.navigate(b.url);
    else if (b.type === "back") await lb.session.back();
    else return res.status(400).json({ error: "Unknown input" });
    res.json({ ok: true, url: lb.session.url });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- Annotate: point at things on the page --------------------------------------

// The element under a point (page pixels), pinned as the next number, with a small picture of it
app.post("/api/browser/:id/inspect", requireToken, async (req, res) => {
  const lb = liveOr404(req, res);
  if (!lb) return;
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: "x and y (page pixels) are needed" });
  lb.pins ??= new Map();
  if (lb.pins.size >= 20) return res.status(400).json({ error: "At most 20 pins: send or clear them first" });
  const n = lb.nextPin ?? 1;
  try {
    const el = await lb.session.inspect(x, y, n);
    if (!el) return res.status(404).json({ error: "Nothing there" });
    lb.nextPin = n + 1;
    lb.pins.set(n, { ...el, url: lb.session.url });
    const shot = await lb.session.clip(el);
    res.json({ n, element: el, url: lb.session.url, shot: shot ? `data:image/jpeg;base64,${shot.data}` : null, crop: shot?.crop ?? null, description: describePin(n, el) });
  } catch (e) {
    res.status(502).json({ error: `Couldn't look at the page: ${e instanceof Error ? e.message : String(e)}` });
  }
});
app.post("/api/browser/:id/pins/clear", requireToken, (req, res) => {
  const lb = liveOr404(req, res);
  if (!lb) return;
  lb.pins?.clear();
  lb.nextPin = 1;
  res.json({ ok: true });
});
// Sends the pins and notes: to the agent working in this browser, or as a new card
app.post("/api/browser/:id/annotate", requireToken, async (req, res) => {
  const lb = liveOr404(req, res);
  if (!lb) return;
  const body = (req.body ?? {}) as { message?: unknown; pins?: unknown; mode?: unknown; project?: unknown };
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";
  const pins = (Array.isArray(body.pins) ? body.pins : [])
    .map((p) => p as { n?: unknown; note?: unknown })
    .filter((p) => typeof p.n === "number" && lb.pins?.has(p.n))
    .slice(0, 20)
    .map((p) => ({ n: p.n as number, note: typeof p.note === "string" ? p.note.trim().slice(0, 500) : "", el: lb.pins!.get(p.n as number)! }));
  if (!message && !pins.some((p) => p.note)) return res.status(400).json({ error: "Say what to do (a message or a note on a pin)" });
  const lines = pins.map((p) => `${describePin(p.n, p.el)}${p.el.url !== lb.session.url ? ` (on ${p.el.url.slice(0, 200)})` : ""}${p.note ? `\n   Note: ${p.note}` : ""}`);
  const task = lb.taskId ? tasks.get(lb.taskId) : undefined;
  if (body.mode === "agent") {
    if (lb.manual || !task || !RUNNING_STATUSES.includes(task.status)) return res.status(409).json({ error: "No agent is working in this browser: make a card instead" });
    lb.notes ??= [];
    lb.notes.push(`${message || "See the notes on the pins."}${lines.length ? `\nPinned on the page:\n${lines.join("\n")}` : ""}`);
    hive.log("browser", "annotate", `you pointed at ${pins.length} thing${pins.length === 1 ? "" : "s"}${message ? `: ${message.slice(0, 80)}` : ""}`, task.id);
    return res.json({ sent: "agent", taskId: task.id });
  }
  // A new card that starts on this page (with this window's sign-ins, saved first)
  if (lb.manual && lb.profile) await lb.session.saveProfile().catch(() => {});
  const prompt =
    `${message || "Do what the notes on the pins say."}\n\nStart on ${lb.session.url}` +
    (lines.length ? `. On that page I pointed at:\n${lines.join("\n")}\n(Find these by their text or position; the pin numbers don't carry over to a new browser.)` : ".");
  const project = typeof body.project === "string" ? body.project : (task?.project ?? null);
  const out = createTask({ prompt, title: (message || pins.find((p) => p.note)?.note || "Annotated page").slice(0, 80), targetAgent: "browser", source: "ui", profile: lb.profile, project, column: "ready" });
  if (!out.task) return res.status(out.status).json({ error: out.error });
  hive.log("browser", "annotate", `new card from ${pins.length} pin${pins.length === 1 ? "" : "s"} on ${lb.session.url.slice(0, 80)}`, out.task.id);
  res.status(201).json({ sent: "card", taskId: out.task.id });
});

// --- Routines (scheduled read-only cards) ------------------------------------
const ROUTINE_TZ = process.env.ROUTINE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const ROUTINE_MIN_MINUTES = Math.max(1, Number(process.env.ROUTINE_MIN_MINUTES) || 5);
const routineEnv = () => ({ telegramChat: telegram ? [...TELEGRAM_ALLOWED][0] : undefined, vault: OBSIDIAN_VAULT || undefined });
const scheduler = new Scheduler(
  store,
  {
    start: (r) => {
      const out = createTask(
        {
          prompt: r.prompt,
          title: r.name,
          targetAgent: r.targetAgent,
          source: "routine",
          deliverTo: r.deliverTo,
          allowedSites: r.allowedSites,
          column: "ready",
          ...(r.profile ? { profile: r.profile } : {}),
          ...(r.project && projects.exists(r.project) ? { project: r.project } : {}),
        },
        { routineId: r.id, mayAct: r.mayAct },
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
      if (r.profile && !profiles.exists(r.profile)) return `There's no browser profile called “${r.profile}”`;
      const p = r.project ? projects.get(r.project) : undefined;
      if (r.project && !p) return "its project was deleted";
      if (p?.archived) return `its project “${p.name}” is archived`;
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
/** A routine's project must exist and be able to use its profile. */
function routineProjectError(body: unknown, current?: { project?: string | null; profile?: string | null }): string | null {
  const b = (body ?? {}) as { project?: unknown; profile?: unknown };
  const project = b.project !== undefined ? b.project : current?.project;
  const profile = b.profile !== undefined ? b.profile : current?.profile;
  if (typeof project === "string" && !projects.exists(project)) return "Unknown project";
  return typeof profile === "string" ? profileProjectError(profile, typeof project === "string" ? project : null) : null;
}

app.post("/api/routines", requireToken, (req, res) => {
  const bad = routineProjectError(req.body);
  if (bad) return res.status(400).json({ error: bad });
  const out = scheduler.create(req.body);
  if ("error" in out) return res.status(400).json(out);
  hive.log("routine", "created", `${out.name}: ${out.label}`);
  res.status(201).json(routineView(out));
});
app.patch("/api/routines/:id", requireToken, (req, res) => {
  const bad = routineProjectError(req.body, scheduler.list().find((r) => r.id === String(req.params.id)));
  if (bad) return res.status(400).json({ error: bad });
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

// --- Brain: shared memory and canon over MCP ---------------------------------
if (brainEnabled()) {
  // Loaded only when configured, so Mission Control still runs without Postgres
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createMcpRouter } = require("./brain/mcp-server") as typeof import("./brain/mcp-server");
  app.use("/mcp", createMcpRouter());
}
app.get("/api/brain", async (_req, res) => {
  res.json({
    enabled: Boolean(brain),
    memoryStore: memory.storeKind,
    memories: await memory.count().catch(() => null),
    mcp: brain ? "/mcp" : null,
    vaultCanon: Boolean(brain && OBSIDIAN_VAULT),
  });
});
app.post("/api/brain/sync-canon", requireToken, async (_req, res) => {
  if (!brain) return res.status(409).json({ error: "The brain isn't configured (DATABASE_URL)" });
  if (!OBSIDIAN_VAULT) return res.status(409).json({ error: "No Obsidian vault is set up (OBSIDIAN_VAULT)" });
  try {
    res.json(await brain.syncCanon());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

async function start() {
  if (brainEnabled()) {
    brain = await startBrain({
      dataDir: DATA_DIR,
      vault: OBSIDIAN_VAULT,
      canonEveryMin: CANON_SYNC_MIN,
      log: (s) => console.log(`[brain] ${s}`),
    });
    memory.useStore(brain.memory);
    console.log(`[brain] shared memory on (${await memory.count()} memories); MCP at /mcp`);
  }
  app.listen(PORT, HOST, onListening);
}

function onListening() {
  console.log(`ts-harness listening on http://${HOST}:${PORT}`);
  console.log(`Ollama: ${OLLAMA_BASE_URL}  Jarvis: ${models.resolve("planner").ref}  router: ${models.resolve("router").ref}`);
  console.log(`Data: ${DATA_DIR}  Obsidian: ${OBSIDIAN_VAULT || "off"}  Telegram: ${telegram ? "on" : "off"}  Browser: ${BROWSER_CDP_URL || "off"}`);
  if (recovered) console.log(`Recovered ${recovered} task(s) interrupted by the last shutdown; they wait for Retry.`);
  // Cards that were queued before the restart pick up where they left off
  void pump();
  scheduler.start();
  const active = scheduler.list().filter((r) => r.enabled).length;
  console.log(`Routines: ${active} active (time zone ${ROUTINE_TZ})`);
  if (voice)
    void voice.health().then((h) =>
      console.log(h?.ok ? `Voice: ${h.voices.length} voices, Whisper ${h.whisper ?? "off"}${h.error ? ` (${h.error})` : ""} at ${VOICE_URL}` : `Voice: the voice service at ${VOICE_URL} isn't answering yet (it may still be building)`),
    );
  if (tools)
    void tools
      .list()
      .then((servers) => console.log(`Tools: ${servers.map((s) => `${s.name} (${s.ok ? `${s.tools.length} tools, ${s.tools.filter((t) => t.readOnly).length} read-only` : s.error})`).join(", ") || "no servers"} at ${TOOLS_URL}`))
      .catch((e) => console.log(`Tools: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        // The router and the lead learn what the tools do; checked again every 5 minutes
        void refreshToolsSummary();
        setInterval(() => void refreshToolsSummary(true), 5 * 60_000).unref();
      });
  console.log(`Assets: ${assets.list().length} in the dictionary${assets.branded() ? `, brand "${assets.brand().name || "set"}"` : ""}`);
  if (video)
    void video.health().then((h) =>
      console.log(h?.ok ? `Videos: Remotion ${h.remotion} ready at ${VIDEO_RENDER_URL}` : `Videos: the video service at ${VIDEO_RENDER_URL} isn't answering yet (it may still be building)`),
    );
}

start().catch((err) => {
  // Without its memory store Mission Control would silently lose memories, so it stops;
  // Docker restarts it once the database is reachable
  console.error(`[brain] startup failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
