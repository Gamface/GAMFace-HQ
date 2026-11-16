// Overview: the home page. One glance at Jarvis, the machine, the team, the
// board, routines and recent activity, with a box to dispatch a task. The
// Console stays the working view (live output, browser, attachments).
import { useEffect, useState, type ReactNode } from "react";
import type { AgentStatus } from "../../../src/schemas/agent";
import { HARNESS_URL } from "../config";
import { TERMINAL, type TaskView } from "../useAgentStream";

export interface OverviewSystem {
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
  memories?: number;
}

interface HiveEntry {
  ts: number;
  agent: string;
  event: string;
  summary: string;
}
interface BoardCard {
  id: string;
  title?: string;
  prompt: string;
  column: "backlog" | "ready" | "running" | "review" | "done" | "failed";
  targetAgent: string;
  delegatedTo?: string[];
  startedAt?: number;
}
interface Routine {
  id: string;
  name: string;
  label: string;
  enabled: boolean;
  deliverTo: "dashboard" | "telegram" | "obsidian";
  upcoming: number[];
}
interface MemoryItem {
  id: number | string;
  text: string;
  pinned: boolean;
  importance: number;
}

const TEAM: [key: string, name: string, role: string][] = [
  ["planner", "Jarvis", "Lead · delegates"],
  ["coder", "Coder", "TypeScript · Python"],
  ["browser", "Browser", "Web agent"],
  ["file", "File", "Vault & disk"],
  ["security_audit", "Security", "Defensive audits"],
  ["vision", "Vision", "Reads pictures"],
];

const WORKING: AgentStatus[] = ["routing", "delegating", "thinking", "streaming", "executing_tool", "writing_diff"];
const COLUMNS: [BoardCard["column"], string][] = [
  ["backlog", "Backlog"],
  ["ready", "Ready"],
  ["running", "Running"],
  ["review", "Review"],
  ["done", "Done"],
];
const DELIVERY = { dashboard: "Dashboard", telegram: "Telegram", obsidian: "Obsidian" };

const getJson = <T,>(path: string): Promise<T> => fetch(`${HARNESS_URL}${path}`).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(r.status)));

/** Re-fetches every `ms` while the page is open. */
function usePoll<T>(path: string, ms: number): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => getJson<T>(path).then((d) => live && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, ms);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [path, ms]);
  return data;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const greeting = (h: number) => (h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const clockTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const nextRun = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? time(t) : d.toLocaleDateString([], { weekday: "short" }) + " " + time(t);
};
const elapsed = (from?: number) => {
  if (!from) return "";
  const s = Math.max(0, Math.round((Date.now() - from) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const shortModel = (ref?: string) => (ref ?? "").replace(/^ollama\//, "");

function Panel({ title, aside, className = "", hud = false, children }: { title: string; aside?: ReactNode; className?: string; hud?: boolean; children: ReactNode }) {
  return (
    <section aria-label={title} className={`${hud ? "hud " : ""}bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col gap-4 min-w-0 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-[15px] font-semibold tracking-wide text-slate-100">{title}</h2>
        {aside && <div className="text-xs text-slate-500 font-mono truncate">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function Pill({ ok, warn, children, title }: { ok?: boolean; warn?: boolean; children: ReactNode; title?: string }) {
  const tone = warn ? "border-amber-800 bg-amber-950 text-amber-300" : ok === false ? "border-rose-800 bg-rose-950 text-rose-300" : "border-slate-800 bg-slate-900 text-slate-400";
  const dot = warn ? "bg-amber-400" : ok === false ? "bg-rose-400" : "bg-slate-100";
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap ${tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

function Orb({ busy }: { busy: boolean }) {
  return (
    <div aria-hidden="true" className="relative h-44 w-44 shrink-0">
      <div className="absolute inset-0 rounded-full border border-dashed border-cyan-900" />
      <div className={`absolute inset-4 rounded-full border-2 border-transparent border-t-cyan-500 border-r-cyan-500 ${busy ? "animate-spin [animation-duration:3s]" : "-rotate-[30deg]"}`} />
      <div className="absolute inset-8 rounded-full border border-cyan-900" />
      <div className="absolute inset-12 rounded-full border border-cyan-500 bg-[radial-gradient(circle,var(--color-cyan-900)_0%,var(--color-cyan-950)_60%,var(--color-slate-900)_100%)]" />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="font-display font-bold text-lg tracking-[0.2em] text-cyan-400">HQ</span>
      </div>
    </div>
  );
}

export default function OverviewPage({
  tasks,
  system,
  connection,
  projectQuery,
  onDispatch,
  onOpenTask,
  onNavigate,
}: {
  tasks: TaskView[];
  system: OverviewSystem | null;
  connection: string;
  projectQuery: string;
  onDispatch: (prompt: string) => Promise<string | null>;
  onOpenTask: (id: string) => void;
  onNavigate: (view: "console" | "board" | "routines" | "team") => void;
}) {
  const now = useClock();
  const q = projectQuery ? `${projectQuery}&` : "";
  const board = usePoll<BoardCard[]>("/api/board", 5000);
  const hive = usePoll<HiveEntry[]>(`/api/hive?${q}limit=9`, 4000);
  const memories = usePoll<MemoryItem[]>(`/api/memories${projectQuery ? `?${projectQuery}` : ""}`, 15_000);
  const models = usePoll<{ resolved: Record<string, string> }>("/api/models", 30_000);
  const routines = usePoll<{ routines: Routine[] }>("/api/routines", 30_000);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = tasks.filter((t) => !TERMINAL.includes(t.status) && t.status !== "backlog");
  const running = tasks.find((t) => t.id === system?.running) ?? active.find((t) => WORKING.includes(t.status));
  const runningCard = board?.find((c) => c.column === "running");
  const counts = Object.fromEntries(COLUMNS.map(([c]) => [c, board?.filter((b) => b.column === c).length ?? 0]));
  const failed = board?.filter((b) => b.column === "failed").length ?? 0;
  const ollamaUp = system?.ollama === "up";
  const pinned = (memories ?? []).filter((m) => m.pinned).slice(0, 3);
  const topMemories = pinned.length ? pinned : [...(memories ?? [])].sort((a, b) => b.importance - a.importance).slice(0, 3);
  const nextRoutines = (routines?.routines ?? []).filter((r) => r.enabled && r.upcoming.length).sort((a, b) => a.upcoming[0] - b.upcoming[0]).slice(0, 3);

  const agentState = (key: string) => {
    const mine = active.filter((t) => t.agent === key);
    const working = mine.find((t) => WORKING.includes(t.status));
    if (working) return { label: "Working", tone: "text-cyan-400", dot: "bg-cyan-500 animate-pulse", doing: working.title, live: true };
    if (mine.length) return { label: "Queued", tone: "text-amber-300", dot: "bg-amber-400", doing: mine[0].title, live: false };
    return { label: "Idle", tone: "text-slate-400", dot: "bg-slate-500", doing: "", live: false };
  };

  const dispatch = async () => {
    if (!prompt.trim() || sending) return;
    setSending(true);
    setError(null);
    const err = await onDispatch(prompt.trim());
    setSending(false);
    if (err) setError(err);
    else setPrompt("");
  };

  return (
    <div className="col-span-3 min-h-0 overflow-y-auto pr-1">
      <div className="flex flex-col gap-4 pb-6">
        {/* Greeting, status, clock */}
        <header className="flex flex-wrap items-end justify-between gap-4 px-1 pt-1">
          <div className="flex flex-col gap-1.5">
            <div className="font-mono text-xs tracking-[0.2em] text-cyan-400">GAMFACE HQ · MISSION CONTROL</div>
            <h1 className="font-display text-4xl font-semibold leading-tight">{greeting(now.getHours())}</h1>
            <p className="text-sm text-slate-400">
              {running ? "1 card running" : "Nothing running"} · {system?.queued ?? 0} queued
              {system?.preset ? ` · preset ${system.preset}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex flex-wrap gap-2">
              <Pill ok={connection === "open"} warn={connection === "connecting"} title="Connection to the harness">
                Harness {connection === "open" ? "online" : connection}
              </Pill>
              <Pill ok={ollamaUp} title="Ollama, from /api/ps">Ollama {ollamaUp ? "up" : "down"}</Pill>
              {system?.telegram && <Pill>Telegram</Pill>}
              {system?.obsidian && <Pill>Obsidian</Pill>}
              {system?.browser && <Pill>Browser</Pill>}
            </div>
            <div className="text-right">
              <div className="font-display text-5xl font-medium leading-none tracking-wide tabular-nums">
                {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
              </div>
              <div className="mt-1 text-xs text-slate-500">{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-12 gap-4">
          {/* Jarvis */}
          <Panel title="Jarvis" aside={shortModel(system?.model)} hud className="col-span-12 lg:col-span-6 2xl:col-span-4 items-center">
            <Orb busy={Boolean(running)} />
            <div className="text-center min-w-0 max-w-full">
              {running ? (
                <>
                  <div className="text-sm font-medium text-cyan-400 animate-pulse">Working</div>
                  <button onClick={() => onOpenTask(running.id)} className="mt-0.5 max-w-full truncate text-xs text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline">
                    {running.title}
                  </button>
                </>
              ) : (
                <>
                  <div className="text-sm font-medium text-slate-200">Ready</div>
                  <div className="mt-0.5 text-xs text-slate-500">Type a task; Jarvis routes it to the right agent</div>
                </>
              )}
            </div>
            <form
              className="flex w-full gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void dispatch();
              }}
            >
              <label htmlFor="overview-dispatch" className="sr-only">
                Dispatch a task
              </label>
              <input
                id="overview-dispatch"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Dispatch a task…"
                className="h-11 min-w-0 flex-1 rounded-lg border border-slate-800 bg-slate-950 px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!prompt.trim() || sending || connection !== "open"}
                className="h-11 rounded-lg bg-cyan-600 px-4 text-sm font-semibold text-white hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500"
              >
                Run
              </button>
            </form>
            {error && <p className="w-full text-xs font-mono text-rose-300">{error}</p>}
          </Panel>

          {/* System */}
          <Panel title="System" aside={system ? (ollamaUp ? "Ollama" : "Ollama down") : "…"} className="col-span-12 lg:col-span-6 2xl:col-span-4">
            <div className="grid grid-cols-3 gap-2.5">
              <Stat value={running ? "1" : "0"} label="running" accent={Boolean(running)} />
              <Stat value={String(system?.queued ?? 0)} label="queued" />
              <Stat value={String(system?.models.length ?? 0)} label="models loaded" />
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="text-[11px] tracking-[0.1em] text-slate-500">LOADED MODELS · SHARE ON GPU</div>
              {(system?.models.length ?? 0) === 0 && <div className="text-xs text-slate-500">No model in memory right now.</div>}
              {system?.models.map((m) => (
                <div key={m.name} className="flex flex-col gap-1.5" title={m.vramPct < 100 ? "Under 100% means part of the model runs on the CPU" : undefined}>
                  <div className="flex justify-between gap-2 font-mono text-xs">
                    <span className="truncate text-slate-200">{m.name}</span>
                    <span className={m.vramPct < 100 ? "text-amber-300" : "text-slate-400"}>
                      {m.vramPct}% of {m.sizeGB} GB
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                    <div className={`h-full rounded-full ${m.vramPct < 100 ? "bg-amber-400" : "bg-cyan-500"}`} style={{ width: `${Math.min(100, m.vramPct)}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-auto flex justify-between gap-2 rounded-lg bg-slate-950 px-3 py-2 font-mono text-xs">
              <span className="text-slate-500">router · memory</span>
              <span className="truncate text-slate-300">{shortModel(system?.fastModel) || "—"}</span>
            </div>
          </Panel>

          {/* Memory */}
          <Panel title="Memory" aside={`${system?.memories ?? 0} saved`} className="col-span-12 lg:col-span-12 2xl:col-span-4">
            <div className="flex items-baseline gap-2.5">
              <span className="font-display text-5xl font-semibold leading-none">{system?.memories ?? 0}</span>
              <span className="text-sm text-slate-400">memories</span>
            </div>
            <div className="flex flex-col gap-2">
              {topMemories.length === 0 && <div className="text-xs text-slate-500">Saved after tasks finish.</div>}
              {topMemories.map((m) => (
                <div key={m.id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2.5 text-[13px] leading-snug text-slate-200">
                  {m.text}
                  <div className="mt-1 text-[11px] text-slate-500">{m.pinned ? "Pinned" : `Importance ${m.importance.toFixed(2)}`}</div>
                </div>
              ))}
            </div>
          </Panel>

          {/* Team */}
          <Panel
            title="Team"
            aside={
              <button onClick={() => onNavigate("team")} className="text-cyan-400 hover:text-cyan-300 font-sans">
                Models &amp; caps
              </button>
            }
            className="col-span-12 xl:col-span-7"
          >
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {TEAM.map(([key, name, role]) => {
                const s = agentState(key);
                return (
                  <div key={key} className={`flex items-start gap-3 rounded-lg border bg-slate-950/60 p-3 ${s.live ? "border-cyan-900" : "border-slate-800"}`}>
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-800 bg-slate-950 font-display font-semibold ${s.live ? "text-cyan-400" : "text-slate-100"}`}>
                      {name[0]}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{name}</span>
                        <span className={`inline-flex items-center gap-1.5 text-[11px] ${s.tone}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                          {s.label}
                        </span>
                      </div>
                      <span className="truncate font-mono text-[11px] text-slate-500">{shortModel(models?.resolved?.[key]) || "…"}</span>
                      <span className="truncate text-xs text-slate-400">{s.doing || role}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* Board */}
          <Panel
            title="Board"
            aside={
              <button onClick={() => onNavigate("board")} className="text-cyan-400 hover:text-cyan-300 font-sans">
                Open board
              </button>
            }
            className="col-span-12 xl:col-span-5"
          >
            <div className="grid grid-cols-5 gap-2">
              {COLUMNS.map(([c, label]) => (
                <div key={c} className={`rounded-lg border bg-slate-950/60 px-1 py-2.5 text-center ${c === "running" && counts[c] ? "border-cyan-900" : "border-slate-800"}`}>
                  <div className={`font-display text-2xl font-semibold ${c === "running" && counts[c] ? "text-cyan-400" : "text-slate-100"}`}>{counts[c]}</div>
                  <div className="text-[11px] text-slate-500">{label}</div>
                </div>
              ))}
            </div>
            {failed > 0 && <div className="text-xs text-rose-300">{failed} failed card{failed === 1 ? "" : "s"} on the board</div>}
            {runningCard ? (
              <div className="flex flex-col gap-2.5 rounded-lg border border-cyan-900 bg-cyan-950/60 p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] tracking-[0.1em] text-cyan-400">RUNNING</span>
                  <span className="font-mono text-xs text-slate-400 tabular-nums">{elapsed(runningCard.startedAt)}</span>
                </div>
                <div className="line-clamp-2 font-semibold">{runningCard.title || runningCard.prompt}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                  {[runningCard.targetAgent, ...(runningCard.delegatedTo ?? [])].map((a, i) => (
                    <span key={`${a}-${i}`} className="flex items-center gap-1.5">
                      {i > 0 && <span className="text-slate-600">→</span>}
                      {TEAM.find(([k]) => k === a)?.[1] ?? a}
                    </span>
                  ))}
                </div>
                <div>
                  <button onClick={() => onOpenTask(runningCard.id)} className="h-9 rounded-lg border border-cyan-900 px-3 text-xs text-slate-100 hover:bg-cyan-950">
                    Open in Console
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-xs text-slate-500">No card running</div>
            )}
          </Panel>

          {/* Hive mind */}
          <Panel title="Hive mind" aside="live" hud className="col-span-12 xl:col-span-6 bg-slate-950">
            <div className="flex flex-col gap-1.5 font-mono text-xs">
              {(hive ?? []).length === 0 && <div className="text-slate-500">No team activity yet.</div>}
              {(hive ?? []).slice(-9).reverse().map((h, i) => (
                <div key={`${h.ts}-${i}`} className="flex min-w-0 items-baseline gap-3">
                  <span className="shrink-0 text-slate-500 tabular-nums">{clockTime(h.ts)}</span>
                  <span className={`w-20 shrink-0 truncate uppercase ${/error|fail/i.test(h.event) ? "text-rose-300" : /deleg|start|run/i.test(h.event) ? "text-cyan-400" : "text-slate-400"}`}>{h.agent}</span>
                  <span className="min-w-0 truncate text-slate-300">
                    <span className="text-slate-500">{h.event}</span> {h.summary}
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          {/* Routines */}
          <Panel
            title="Routines"
            aside={
              <button onClick={() => onNavigate("routines")} className="text-cyan-400 hover:text-cyan-300 font-sans">
                {(routines?.routines ?? []).filter((r) => r.enabled).length} active
              </button>
            }
            className="col-span-12 md:col-span-6 xl:col-span-3"
          >
            {nextRoutines.length === 0 && <div className="text-xs text-slate-500">No routines scheduled.</div>}
            {nextRoutines.map((r, i) => (
              <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2.5">
                <div className="flex justify-between gap-2">
                  <span className="truncate font-medium">{r.name}</span>
                  <span className={`shrink-0 font-mono text-xs ${i === 0 ? "text-cyan-400" : "text-slate-400"}`}>{nextRun(r.upcoming[0])}</span>
                </div>
                <span className="truncate text-xs text-slate-500">
                  {r.label} → {DELIVERY[r.deliverTo] ?? r.deliverTo}
                </span>
              </div>
            ))}
          </Panel>

          {/* Recent cards */}
          <Panel title="Recent" aside={`${tasks.length} cards`} className="col-span-12 md:col-span-6 xl:col-span-3">
            {tasks.length === 0 && <div className="text-xs text-slate-500">No tasks yet.</div>}
            {tasks.slice(0, 5).map((t) => (
              <button key={t.id} onClick={() => onOpenTask(t.id)} className="flex flex-col gap-1 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-left hover:border-slate-700">
                <span className="w-full truncate text-[13px] text-slate-200">{t.title}</span>
                <span className="flex justify-between gap-2 text-[11px]">
                  <span className={t.status === "error" ? "text-rose-300" : t.status === "complete" ? "text-emerald-300" : WORKING.includes(t.status) ? "text-cyan-400" : "text-slate-500"}>{t.status}</span>
                  <span className="text-slate-500">{time(t.createdAt)}</span>
                </span>
              </button>
            ))}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      <div className={`font-display text-2xl font-semibold ${accent ? "text-cyan-400" : ""}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
