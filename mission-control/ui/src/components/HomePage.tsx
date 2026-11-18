import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AGENT_LABELS, defaultPrompt, getJson, send, uploadAudio } from "../api";
import type { Board, BoardCard } from "../api";
import { useProjects } from "../project";
import { TERMINAL } from "../useAgentStream";
import type { Connection, TaskView } from "../useAgentStream";
import type { View } from "./Nav";

// Home: everything at a glance. Talk or type to Jarvis, and see the machine, the
// memory, the team, the board, the activity log, routines and memories.

export interface SystemInfo {
  ollama: "up" | "down";
  model: string;
  models: { name: string; sizeGB: number; vramPct: number }[];
  running: string | null;
  queued: number;
  fastModel?: string;
  preset?: string | null;
  telegram?: boolean;
  obsidian?: boolean;
  browser?: boolean;
  video?: boolean;
  voice?: boolean;
  memories?: number;
  vramUsedGB?: number;
  vramTotalGB?: number;
  speed?: { ref: string; tokensPerSec: number; firstTokenMs: number; at: number } | null;
  vault?: { notes: number; lastChange: number } | null;
  agents?: Record<string, { model: string; localOnly: boolean }>;
}

interface HiveEntry {
  ts: number;
  agent: string;
  event: string;
  summary: string;
  taskId?: string;
}
interface MemoryItem {
  id: string;
  agent: string;
  text: string;
  pinned: boolean;
  hits: number;
  project?: string;
  /** missing or true: never sent to a cloud model */
  private?: boolean;
}
interface Routine {
  id: string;
  name: string;
  label: string;
  deliverTo: string;
  enabled: boolean;
  nextRunAt?: number;
}

const NAME_KEY = "mc.name";
const TEAM = ["planner", "browser", "coder", "file", "security_audit", "vision", "tools"];
const short = (ref?: string | null) => (ref ?? "—").replace(/^ollama\//, "");
const isCloud = (ref?: string | null) => Boolean(ref) && !ref!.startsWith("ollama/");
const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}
function until(t?: number): string {
  if (!t) return "—";
  const s = (t - Date.now()) / 1000;
  if (s <= 0) return "due";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `in ${Math.floor(s / 3600)}:${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`;
  return new Date(t).toLocaleDateString("en-US", { weekday: "short" });
}

function Card({ title, right, children, className = "", accent = false }: { title?: string; right?: ReactNode; children: ReactNode; className?: string; accent?: boolean }) {
  return (
    <section className={`bg-slate-900 border rounded-xl p-4 min-w-0 flex flex-col ${accent ? "border-cyan-700/70" : "border-slate-800"} ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <div className="text-[10px] font-mono text-slate-500">{right}</div>
        </div>
      )}
      {children}
    </section>
  );
}

function Stat({ value, unit, label }: { value: ReactNode; unit?: string; label: string }) {
  return (
    <div className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 min-w-0">
      <div className="text-xl font-bold text-slate-100 leading-tight truncate">
        {value}
        {unit && <span className="text-[10px] font-normal text-slate-500 ml-0.5">{unit}</span>}
      </div>
      <div className="text-[10px] font-mono text-slate-500 truncate">{label}</div>
    </div>
  );
}

const Mic = ({ className = "h-6 w-6" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

/** Records from the microphone; stop() resolves with the recording. Audio never leaves your PC: the Transcriber agent turns it into text. */
export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const done = useRef<((b: Blob) => void) | null>(null);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const r = new MediaRecorder(stream);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      done.current?.(new Blob(chunks.current, { type: r.mimeType || "audio/webm" }));
    };
    r.start();
    rec.current = r;
    setSeconds(0);
    setRecording(true);
  };
  const stop = () =>
    new Promise<Blob>((resolve) => {
      done.current = resolve;
      rec.current?.stop();
    });
  return { recording, seconds, start, stop };
}

export default function HomePage({
  connection,
  tasks,
  system,
  onNavigate,
  onOpenTask,
  micSignal,
}: {
  connection: Connection;
  tasks: TaskView[];
  system: SystemInfo | null;
  onNavigate: (view: View) => void;
  onOpenTask: (id: string) => void;
  /** Changes when the mic button in the phone's tab bar is pressed */
  micSignal: number;
}) {
  const proj = useProjects();
  const [now, setNow] = useState(Date.now());
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) || import.meta.env.VITE_USER_NAME || "";
    } catch {
      return "";
    }
  });
  const [board, setBoard] = useState<Board | null>(null);
  const [hive, setHive] = useState<HiveEntry[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"" | "sending" | "transcribing">("");
  const [error, setError] = useState<string | null>(null);
  const mic = useRecorder();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const q = proj.query;
    const load = () => {
      getJson<Board>("/api/board").then(setBoard).catch(() => {});
      getJson<HiveEntry[]>(`/api/hive?limit=9${q ? `&${q}` : ""}`).then(setHive).catch(() => {});
      getJson<MemoryItem[]>(`/api/memories${q ? `?${q}` : ""}`).then(setMemories).catch(() => {});
      getJson<{ routines: Routine[] }>("/api/routines").then((r) => setRoutines(r.routines)).catch(() => {});
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [proj.query]);

  // Share lets cloud models (and Claude Code over the brain) see a memory; Make private hides it again
  const toggleShare = async (m: MemoryItem) => {
    const shared = m.private === false;
    setMemories((all) => all.map((x) => (x.id === m.id ? { ...x, private: shared } : x)));
    try {
      await send("POST", `/api/memories/${encodeURIComponent(m.id)}/${shared ? "private" : "share"}`);
    } catch {
      setMemories((all) => all.map((x) => (x.id === m.id ? { ...x, private: m.private } : x)));
    }
  };

  const run = async (text: string, audio: string[] = []) => {
    setError(null);
    setBusy("sending");
    try {
      const out = await send<{ taskId: string }>("POST", "/api/agent/run", {
        id: crypto.randomUUID(),
        prompt: text.trim() || defaultPrompt(audio.length, 0),
        targetAgent: "auto",
        source: audio.length ? "voice" : "ui",
        project: proj.target,
        audio,
      });
      setPrompt("");
      return out.taskId;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  const toggleMic = async () => {
    setError(null);
    try {
      if (!mic.recording) return await mic.start();
      const blob = await mic.stop();
      setBusy("transcribing");
      const up = await uploadAudio(blob);
      await run(prompt, [up.id]);
    } catch (e) {
      setBusy("");
      setError(e instanceof Error && e.name !== "NotAllowedError" && e.name !== "NotFoundError" ? e.message : "Microphone not available (check the browser's permission; it needs https or localhost)");
    }
  };
  // The phone's tab-bar mic
  const firstSignal = useRef(micSignal);
  useEffect(() => {
    if (micSignal !== firstSignal.current) void toggleMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micSignal]);

  const cards = (board?.cards ?? []).filter((c) => proj.view === "all" || (proj.view === "general" ? !c.project : c.project === proj.view));
  const count = (col: BoardCard["column"]) => cards.filter((c) => c.column === col).length;
  const runningCard = (board?.cards ?? []).find((c) => c.column === "running");
  const runningTask = tasks.find((t) => !TERMINAL.includes(t.status) && t.status !== "queued" && t.status !== "backlog");
  const upNext = cards.filter((c) => c.column === "ready").slice(0, 3);
  const active = tasks.filter((t) => !TERMINAL.includes(t.status) && t.status !== "backlog");
  const agents = system?.agents ?? {};
  const cloudAgents = TEAM.filter((a) => isCloud(agents[a]?.model));
  const hour = new Date(now).getHours();
  const greeting = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const down = !system || system.ollama === "down";
  const vramUsed = system?.vramUsedGB ?? 0;
  const vramTotal = system?.vramTotalGB ?? 16;
  const projectOnly = memories.filter((m) => m.project).length;
  const lastFor = (agent: string) => [...hive].reverse().find((h) => h.agent === agent);
  const orbState = mic.recording ? "Listening…" : busy === "transcribing" ? "Sending your recording…" : runningTask ? `Working: ${runningCard ? (AGENT_LABELS[runningCard.targetAgent] ?? runningCard.targetAgent) : runningTask.agent}` : "Ready";

  const chip = (ok: boolean, text: string, hot = false) => (
    <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-mono whitespace-nowrap ${hot ? "border-cyan-700 bg-cyan-950 text-cyan-300" : "border-slate-800 bg-slate-900 text-slate-300"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${hot ? "bg-cyan-400 animate-pulse" : ok ? "bg-emerald-400" : "bg-slate-600"}`} />
      {text}
    </span>
  );

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-4 pb-24 md:p-6 space-y-4">
      {/* Greeting */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-mono tracking-[0.2em] text-cyan-400 uppercase">Gamface HQ · Mission Control</div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-100">
            {greeting}
            {", "}
            <button
              onClick={() => {
                const n = window.prompt("What should Mission Control call you?", name);
                if (n === null) return;
                setName(n.trim());
                try {
                  localStorage.setItem(NAME_KEY, n.trim());
                } catch {
                  /* private mode */
                }
              }}
              className="text-cyan-400 hover:text-cyan-300"
              title="Change your name"
            >
              {name || "set your name"}
            </button>
          </h1>
          <p className="text-xs font-mono text-slate-400 mt-0.5">
            {connection !== "open" ? `Harness ${connection}…` : `${active.filter((t) => t.status !== "queued").length} card${active.filter((t) => t.status !== "queued").length === 1 ? "" : "s"} running · ${system?.queued ?? 0} queued`}
            {" · "}
            {cloudAgents.length ? `${cloudAgents.map((a) => AGENT_LABELS[a]).join(", ")} on cloud models` : "all agents on local models"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {chip(!down, down ? "Ollama down" : `Ollama · ${system?.speed ? `${Math.round(system.speed.tokensPerSec)} tok/s` : "up"}`)}
          {chip(Boolean(system?.obsidian), system?.obsidian ? "Brain online" : "No vault")}
          {active.length > 0 && chip(true, `${active.length} card${active.length === 1 ? "" : "s"} active`, true)}
          <div className="text-right ml-2 hidden sm:block">
            <div className="text-3xl font-bold text-slate-100 leading-none tabular-nums">{new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</div>
            <div className="text-[10px] font-mono text-slate-500">{new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Jarvis */}
        <Card title="Jarvis" right={short(agents.planner?.model ?? system?.model)} className="lg:col-span-5 max-lg:order-1">
          <div className="flex-1 flex flex-col items-center justify-center py-3">
            <button onClick={() => void toggleMic()} disabled={busy !== ""} className="relative h-36 w-36 flex items-center justify-center disabled:opacity-60" aria-label={mic.recording ? "Stop and send" : "Talk to Jarvis"}>
              <span className="absolute inset-0 rounded-full border border-cyan-900" />
              <span className="absolute inset-3 rounded-full border border-cyan-800/80" />
              {(mic.recording || runningTask) && <span className="absolute inset-3 rounded-full border-2 border-cyan-500 mc-ring" />}
              {mic.recording && <span className="absolute inset-3 rounded-full border-2 border-cyan-500 mc-ring" style={{ animationDelay: "1.2s" }} />}
              <span className={`relative h-16 w-16 rounded-full flex items-center justify-center border ${mic.recording ? "bg-cyan-500 border-cyan-300 text-white" : "bg-cyan-950 border-cyan-600 text-cyan-400 hover:bg-cyan-900"}`}>
                <Mic />
              </span>
            </button>
            <div className={`mt-2 text-xs font-mono ${mic.recording ? "text-cyan-400" : "text-slate-300"}`}>
              {orbState}
              {mic.recording ? ` ${Math.floor(mic.seconds / 60)}:${String(mic.seconds % 60).padStart(2, "0")}` : ""}
            </div>
            <div className="text-[10px] text-slate-500">{mic.recording ? "Press again to send" : "Press the mic to say a task, or type one below"}</div>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (prompt.trim()) void run(prompt);
            }}
          >
            <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Dispatch a task…" className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-600" />
            <button type="submit" disabled={!prompt.trim() || busy !== ""} className="px-4 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-white text-sm font-semibold disabled:opacity-40">
              Run
            </button>
          </form>
          {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
        </Card>

        {/* System */}
        <Card title="System" right={down ? "Ollama down" : (system?.preset ?? "custom models")} className="lg:col-span-4 max-lg:order-3">
          <div className="flex items-baseline justify-between text-[11px] font-mono text-slate-400">
            <span>VRAM</span>
            <span>
              <b className="text-slate-100">{vramUsed.toFixed(1)}</b> / {vramTotal} GB
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-800 mt-1 mb-3 overflow-hidden">
            <div className="h-full rounded-full bg-cyan-500" style={{ width: `${Math.min(100, (100 * vramUsed) / (vramTotal || 1))}%` }} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat value={system?.speed ? Math.round(system.speed.tokensPerSec) : "—"} label="tokens / s" />
            <Stat value={system?.speed ? (system.speed.firstTokenMs / 1000).toFixed(1) : "—"} unit={system?.speed ? "s" : undefined} label="first token" />
            <Stat value={active.filter((t) => t.status !== "queued").length} unit={`/ ${system?.queued ?? 0}`} label="running / queued" />
          </div>
          <div className="mt-3 text-[10px] font-mono tracking-wider text-slate-500 uppercase">Loaded models</div>
          <ul className="mt-1 space-y-1 text-xs font-mono">
            {!system?.models.length && <li className="text-slate-600">{down ? "Ollama isn't answering" : "None loaded (idle)"}</li>}
            {system?.models.map((m) => (
              <li key={m.name} className="flex justify-between gap-2">
                <span className="text-slate-200 truncate">{m.name}</span>
                <span className={m.vramPct < 100 ? "text-amber-400" : "text-slate-500"}>
                  {m.sizeGB} GB{m.vramPct < 100 ? ` · ${m.vramPct}% on GPU` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        {/* Brain */}
        <Card title="Brain" right={system?.obsidian ? "vault connected" : "no vault"} className="lg:col-span-3 max-lg:order-3">
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-bold text-slate-100 tabular-nums">{memories.length}</span>
            <span className="text-xs text-slate-400">memories</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-800 mt-2 overflow-hidden flex">
            <div className="h-full bg-cyan-500" style={{ width: `${memories.length ? (100 * (memories.length - projectOnly)) / memories.length : 0}%` }} />
            <div className="h-full bg-slate-500" style={{ width: `${memories.length ? (100 * projectOnly) / memories.length : 0}%` }} />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-500 mt-1">
            <span>● {memories.length - projectOnly} general</span>
            <span>{projectOnly} in projects</span>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <Stat value={system?.vault ? system.vault.notes : "—"} label="vault notes" />
            <Stat value={system?.vault?.lastChange ? ago(system.vault.lastChange) : "—"} label="last vault change" />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono text-slate-400">
            {(
              [
                ["Browser", system?.browser],
                ["Voice", system?.voice],
                ["Video", system?.video],
                ["Telegram", system?.telegram],
              ] as [string, boolean | undefined][]
            ).map(([label, on]) => (
              <span key={label} className="flex items-center gap-1">
                <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-400" : "bg-slate-700"}`} />
                {label}
              </span>
            ))}
          </div>
        </Card>

        {/* Team */}
        <Card
          title="Team"
          right={
            <button onClick={() => onNavigate("team")} className="text-cyan-400 hover:text-cyan-300">
              Models & caps
            </button>
          }
          className="lg:col-span-6 max-lg:order-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {TEAM.map((a) => {
              // From the board: a task's own agent name is a display label
              const all = board?.cards ?? [];
              const t = all.find((c) => c.column === "running" && c.targetAgent === a) ?? all.find((c) => c.column === "ready" && c.targetAgent === a);
              const state = t ? (t.column === "running" ? "Running" : "Queued") : "Idle";
              const last = lastFor(a);
              return (
                <div key={a} className={`rounded-lg border px-3 py-2 min-w-0 ${state === "Running" ? "border-cyan-800 bg-cyan-950/40" : "border-slate-800 bg-slate-950"}`}>
                  <div className="flex items-center gap-2">
                    <span className={`h-6 w-6 rounded-md flex items-center justify-center text-[11px] font-bold ${state === "Running" ? "bg-cyan-500 text-white" : "bg-slate-800 text-cyan-400"}`}>{(AGENT_LABELS[a] ?? a)[0]}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-slate-100">{AGENT_LABELS[a] ?? a}</div>
                      <div className="text-[10px] font-mono text-slate-500 truncate">
                        {isCloud(agents[a]?.model) ? "☁ " : ""}
                        {short(agents[a]?.model)}
                        {agents[a]?.localOnly ? " · local only" : ""}
                      </div>
                    </div>
                    <span className={`text-[10px] font-mono ${state === "Running" ? "text-cyan-400" : state === "Queued" ? "text-amber-400" : "text-slate-500"}`}>● {state}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400 truncate">{t ? t.title || t.prompt : last ? `Last: ${last.summary}` : "Nothing yet"}</div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Board */}
        <Card
          title="Board"
          right={
            <button onClick={() => onNavigate("board")} className="text-cyan-400 hover:text-cyan-300">
              Open board
            </button>
          }
          className="lg:col-span-6 max-lg:order-2"
        >
          <div className="grid grid-cols-5 gap-2">
            {(
              [
                ["backlog", "Backlog"],
                ["ready", "Ready"],
                ["running", "Running"],
                ["review", "Review"],
                ["done", "Done"],
              ] as [BoardCard["column"], string][]
            ).map(([col, label]) => (
              <div key={col} className={`rounded-lg border px-2 py-2 text-center ${col === "running" && count(col) ? "border-cyan-800 bg-cyan-950/40" : "border-slate-800 bg-slate-950"}`}>
                <div className={`text-xl font-bold tabular-nums ${col === "running" && count(col) ? "text-cyan-400" : "text-slate-100"}`}>{count(col)}</div>
                <div className="text-[10px] font-mono text-slate-500">{label}</div>
              </div>
            ))}
          </div>
          {runningCard ? (
            <div className="mt-3 rounded-lg border border-cyan-800 bg-cyan-950/30 p-3">
              <div className="flex justify-between text-[10px] font-mono">
                <span className="text-cyan-400 tracking-wider">{runningCard.awaitingApproval ? "WAITING FOR YOUR OK" : "RUNNING"}</span>
                <span className="text-slate-400">{ago(runningCard.createdAt)}</span>
              </div>
              <div className="text-sm font-semibold text-slate-100 mt-1 truncate">{runningCard.title || runningCard.prompt}</div>
              <div className="text-[10px] font-mono text-slate-400">
                {AGENT_LABELS[runningCard.targetAgent] ?? runningCard.targetAgent}
                {runningTask ? ` · ${runningTask.status.replace("_", " ")}` : ""}
              </div>
              <div className="h-1 rounded-full bg-slate-800 mt-2 overflow-hidden">
                <div className="h-full w-1/3 rounded-full bg-cyan-500 mc-slide" />
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={() => onOpenTask(runningCard.id)} className="px-3 py-1 rounded-md bg-slate-100 text-slate-950 text-xs font-semibold hover:bg-white">
                  Open card
                </button>
                <button onClick={() => void send("POST", `/api/agent/${runningCard.id}/cancel`).catch(() => {})} className="px-3 py-1 rounded-md border border-slate-700 text-slate-300 text-xs hover:bg-slate-800">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-slate-800 p-3 text-xs text-slate-500">Nothing is running.</div>
          )}
          {upNext.length > 0 && (
            <>
              <div className="mt-3 text-[10px] font-mono tracking-wider text-slate-500 uppercase">Up next</div>
              <ul className="mt-1 divide-y divide-slate-800">
                {upNext.map((c) => (
                  <li key={c.id} className="flex justify-between gap-3 py-1.5 text-xs">
                    <span className="text-slate-200 truncate">{c.title || c.prompt}</span>
                    <span className="font-mono text-[10px] text-slate-500 shrink-0">{AGENT_LABELS[c.targetAgent] ?? c.targetAgent}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        {/* Hive mind */}
        <Card
          title="Hive mind"
          right={
            <button onClick={() => onNavigate("console")} className="text-cyan-400 hover:text-cyan-300">
              Console
            </button>
          }
          className="lg:col-span-6 max-lg:order-4"
          accent
        >
          <ul className="font-mono text-[11px] space-y-1 min-w-0">
            {hive.length === 0 && <li className="text-slate-600">No activity yet.</li>}
            {hive.map((h, i) => (
              <li key={i} className="flex gap-3 min-w-0">
                <span className="text-slate-600 shrink-0 tabular-nums">{clock(h.ts)}</span>
                <span className="text-cyan-400 uppercase shrink-0 w-16 truncate">{h.agent}</span>
                <span className="text-slate-300 truncate">
                  {h.event}: {h.summary}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        {/* Routines */}
        <Card
          title="Routines"
          right={
            <button onClick={() => onNavigate("routines")} className="text-cyan-400 hover:text-cyan-300">
              {routines.filter((r) => r.enabled).length} active
            </button>
          }
          className="lg:col-span-3 max-lg:order-4"
        >
          <ul className="space-y-2">
            {routines.length === 0 && <li className="text-xs text-slate-500">No routines yet.</li>}
            {routines
              .filter((r) => r.enabled)
              .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity))
              .slice(0, 4)
              .map((r) => (
                <li key={r.id} className="flex justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-100 truncate">{r.name}</div>
                    <div className="text-[10px] font-mono text-slate-500 truncate">
                      {r.label} · {r.deliverTo}
                    </div>
                  </div>
                  <span className={`text-[10px] font-mono shrink-0 ${r.nextRunAt && r.nextRunAt - now < 3_600_000 ? "text-cyan-400" : "text-slate-400"}`}>{until(r.nextRunAt)}</span>
                </li>
              ))}
          </ul>
        </Card>

        {/* Memory */}
        <Card
          title="Memory"
          right={
            <button onClick={() => onNavigate("console")} className="text-cyan-400 hover:text-cyan-300">
              All
            </button>
          }
          className="lg:col-span-3 max-lg:order-4"
        >
          <ul className="space-y-2">
            {memories.length === 0 && <li className="text-xs text-slate-500">Nothing remembered yet.</li>}
            {[...memories]
              .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.hits - a.hits)
              .slice(0, 4)
              .map((m) => (
                <li key={m.id} className="min-w-0 flex gap-2 items-start">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-100 truncate" title={m.text}>
                      {m.text}
                    </div>
                    <div className="text-[10px] font-mono text-slate-500">
                      {m.project ? (proj.byId(m.project)?.name ?? "project") : "General"}
                      {m.pinned ? " · pinned" : ""}
                      {m.hits ? ` · used ${m.hits}×` : ""}
                      {m.private === false ? " · ☁ shared" : " · 🔒 private"}
                    </div>
                  </div>
                  <button
                    onClick={() => void toggleShare(m)}
                    className="shrink-0 text-[10px] text-slate-400 hover:text-slate-100"
                    title={m.private === false ? "Hide from cloud models again" : "Let cloud models and Claude Code see this memory"}
                  >
                    {m.private === false ? "Make private" : "Share"}
                  </button>
                </li>
              ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
