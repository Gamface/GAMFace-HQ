import { useEffect, useRef, useState } from "react";
import type { AgentStatus, RequestedAgent } from "../../../src/schemas/agent";
import { HARNESS_URL, authHeaders } from "../config";
import { TERMINAL, useAgentStream } from "../useAgentStream";
import Board from "./Board";
import NoticesBar from "./NoticesBar";
import BrowserPane from "./BrowserPane";
import PreviewPane from "./PreviewPane";
import TeamPage from "./TeamPage";

interface SystemInfo {
  ollama: "up" | "down";
  model: string;
  models: { name: string; sizeGB: number; vramPct: number }[];
  running: string | null;
  queued: number;
  fastModel?: string;
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
  taskId?: string;
}

interface MemoryItem {
  id: number;
  agent: string;
  text: string;
  importance: number;
  pinned: boolean;
  hits: number;
}

type RightTab = "commands" | "hive" | "memory";
type CenterTab = "output" | "preview" | "browser";
type View = "console" | "board" | "team";

const STATUS_STYLES: Record<AgentStatus, string> = {
  idle: "bg-slate-700 text-slate-200",
  backlog: "bg-slate-800 text-slate-400",
  queued: "bg-slate-700 text-slate-200",
  routing: "bg-sky-700/80 text-white",
  delegating: "bg-fuchsia-700/80 text-white",
  thinking: "bg-amber-600/80 text-white",
  streaming: "bg-cyan-600/80 text-white",
  executing_tool: "bg-violet-600/80 text-white",
  writing_diff: "bg-violet-600/80 text-white",
  complete: "bg-emerald-600/80 text-white",
  canceled: "bg-slate-600 text-slate-200",
  error: "bg-rose-600/80 text-white",
};

function StatusBadge({ status }: { status: AgentStatus }) {
  return <span className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide ${STATUS_STYLES[status]}`}>{status}</span>;
}

export default function MissionControl() {
  const { connection, tasks, statusEvents } = useAgentStream(HARNESS_URL);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [targetAgent, setTargetAgent] = useState<RequestedAgent>("auto");
  const [rightTab, setRightTab] = useState<RightTab>("commands");
  const [centerTab, setCenterTab] = useState<CenterTab>("output");
  const [view, setView] = useState<View>(() => (["board", "team"].includes(location.hash.slice(1)) ? (location.hash.slice(1) as View) : "console"));
  useEffect(() => {
    if (location.hash.slice(1) !== (view === "console" ? "" : view)) history.pushState(null, "", view === "console" ? location.pathname : `#${view}`);
  }, [view]);
  // Follow the address bar (back/forward, or a pasted #board / #team link)
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.slice(1);
      setView(h === "board" || h === "team" ? h : "console");
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, []);
  const [hive, setHive] = useState<HiveEntry[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [newMemory, setNewMemory] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const telemetryRef = useRef<HTMLDivElement>(null);

  // Follow the newest task unless the user picked one
  const selected = tasks.find((t) => t.id === selectedId) ?? tasks[0];
  const selectedActive = selected && !TERMINAL.includes(selected.status);

  useEffect(() => {
    const load = () =>
      fetch(`${HARNESS_URL}/api/system`)
        .then((r) => r.json())
        .then(setSystem)
        .catch(() => setSystem(null));
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  // Hive mind and memory panels refresh while they are open
  const loadHive = () =>
    fetch(`${HARNESS_URL}/api/hive?limit=150`)
      .then((r) => r.json())
      .then(setHive)
      .catch(() => {});
  const loadMemories = () =>
    fetch(`${HARNESS_URL}/api/memories`)
      .then((r) => r.json())
      .then(setMemories)
      .catch(() => {});
  useEffect(() => {
    if (rightTab === "commands") return;
    const load = rightTab === "hive" ? loadHive : loadMemories;
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [rightTab]);

  const memoryAction = async (path: string, body?: unknown) => {
    await fetch(`${HARNESS_URL}/api/memories${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    void loadMemories();
  };

  useEffect(() => {
    if (autoScroll && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [selected?.output, autoScroll]);

  useEffect(() => {
    if (telemetryRef.current) telemetryRef.current.scrollTop = telemetryRef.current.scrollHeight;
  }, [statusEvents.length, hive.length, rightTab]);

  const handleRunTask = async () => {
    if (!prompt.trim()) return;
    setDispatchError(null);
    try {
      const res = await fetch(`${HARNESS_URL}/api/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ id: crypto.randomUUID(), prompt, targetAgent, source: "ui" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : JSON.stringify(body.error));
      setSelectedId(body.taskId);
      setPrompt("");
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancel = async () => {
    if (!selected) return;
    await fetch(`${HARNESS_URL}/api/agent/${selected.id}/cancel`, { method: "POST", headers: authHeaders() });
  };

  const gpu = system?.models[0];
  const connectionDot =
    connection === "open" ? "bg-emerald-500 animate-pulse" : connection === "connecting" ? "bg-amber-500" : "bg-rose-500";

  return (
    <div className="grid grid-cols-[260px_1fr_380px] grid-rows-[60px_1fr] gap-4 h-screen p-4 bg-slate-950 text-slate-100 font-sans">
      {/* HEADER TILE */}
      <header className="col-span-3 bg-slate-900 border border-slate-800 rounded-xl px-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`h-3 w-3 rounded-full ${connectionDot}`} title={`Harness: ${connection}`} />
          <h1 className="font-semibold text-lg tracking-wide">Mission Control — Sandcastle & Jarvis</h1>
          <nav className="ml-4 flex gap-1 text-xs">
            {(
              [
                ["console", "Console"],
                ["board", "Board"],
                ["team", "Team"],
              ] as [View, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`px-3 py-1 rounded-md font-medium ${view === key ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm font-mono">
          <NoticesBar />
          <span className="text-cyan-400">
            State: {connection !== "open" ? `Harness ${connection}` : selected ? `${selected.agent} [${selected.status}]` : "Online / Ready"}
          </span>
          <span className="bg-slate-800 px-3 py-1 rounded-md border border-slate-700">Model: {system?.model ?? "—"}</span>
          {system?.telegram && <span className="bg-slate-800 px-3 py-1 rounded-md border border-slate-700" title="Telegram bot is polling">✈ Telegram</span>}
          <span
            className={`px-3 py-1 rounded-md border ${
              !system || system.ollama === "down"
                ? "bg-rose-950 border-rose-800 text-rose-300"
                : gpu && gpu.vramPct < 100
                  ? "bg-amber-950 border-amber-800 text-amber-300"
                  : "bg-slate-800 border-slate-700"
            }`}
            title="From Ollama /api/ps. Under 100% means part of the model runs on the CPU."
          >
            {!system || system.ollama === "down"
              ? "Ollama: down"
              : gpu
                ? `GPU: ${gpu.vramPct}% of ${gpu.sizeGB} GB`
                : "GPU: idle"}
          </span>
        </div>
      </header>

      {view === "board" && <Board />}
      {view === "team" && <TeamPage />}
      {view === "console" && (<>
      {/* LEFT: TASK HISTORY */}
      <aside className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-4 min-h-0">
        <div className="flex-1 min-h-0 flex flex-col">
          <h2 className="text-xs uppercase tracking-wider text-slate-500 mb-3 font-semibold">
            Tasks {system && system.queued > 0 && <span className="normal-case text-slate-400">· {system.queued} queued</span>}
          </h2>
          <nav className="space-y-1 text-sm overflow-y-auto">
            {tasks.length === 0 && <p className="text-slate-600 italic text-xs">No tasks yet.</p>}
            {tasks.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`w-full text-left px-3 py-2 rounded flex flex-col gap-1 ${
                  t.id === selected?.id ? "bg-slate-800 text-slate-100" : "hover:bg-slate-800/60 text-slate-400"
                }`}
              >
                <span className="truncate font-mono text-xs">{t.title}</span>
                <span className="flex items-center gap-2 text-[10px] text-slate-500">
                  <StatusBadge status={t.status} />
                  {t.source === "voice" && (
                    <span className="px-1.5 py-0.5 rounded bg-fuchsia-700/70 text-white uppercase tracking-wide" title="Spoken to Jarvis">
                      🎙 voice
                    </span>
                  )}
                  {t.source === "telegram" && (
                    <span className="px-1.5 py-0.5 rounded bg-sky-700/70 text-white uppercase tracking-wide" title="Sent from Telegram">
                      ✈ tg
                    </span>
                  )}
                  {new Date(t.createdAt).toLocaleTimeString()}
                </span>
              </button>
            ))}
          </nav>
        </div>
        <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-slate-400">
          <span className="text-emerald-400 font-semibold block mb-1">Sub-Agent Mode:</span>
          <select
            value={targetAgent}
            onChange={(e) => setTargetAgent(e.target.value as RequestedAgent)}
            className="w-full bg-slate-900 border border-slate-700 text-slate-200 rounded p-1 font-mono"
          >
            <option value="auto">auto (route for me)</option>
            <option value="planner">planner (Lead — delegates)</option>
            <option value="security_audit">security_audit (Defensive Scan)</option>
            <option value="coder">coder (TypeScript / Python)</option>
            <option value="browser">browser (Web Agent)</option>
            <option value="file">file (Vault & Disk)</option>
          </select>
        </div>
      </aside>

      {/* CENTER: OUTPUT */}
      <main className="bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden min-h-0">
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/40 px-4 py-2 text-xs">
          <div className="flex gap-1">
            {(
              [
                ["output", "Output Stream"],
                ["preview", "Preview"],
                ["browser", "Browser"],
              ] as [CenterTab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setCenterTab(key)}
                className={`px-3 py-1 rounded font-medium ${centerTab === key ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {centerTab === "output" && (
            <label className="flex items-center gap-2 text-slate-400 cursor-pointer select-none">
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
              Auto-scroll
            </label>
          )}
        </div>
        {centerTab === "output" && (
          <div ref={outputRef} className="flex-1 p-6 overflow-y-auto font-mono text-sm leading-relaxed text-slate-300">
            {selected ? (
              <pre className="whitespace-pre-wrap break-words font-mono">{selected.output}</pre>
            ) : (
              <p className="text-slate-600 italic">// No active run. Dispatch a prompt to begin.</p>
            )}
          </div>
        )}
        {centerTab === "preview" && <PreviewPane output={selected?.output ?? ""} active={Boolean(selectedActive)} />}
        <BrowserPane
          baseUrl={HARNESS_URL}
          enabled={Boolean(system?.browser)}
          visible={centerTab === "browser"}
          onStart={() => setCenterTab((tab) => (tab === "output" ? "browser" : tab))}
        />
      </main>

      {/* RIGHT: TELEMETRY + DISPATCH */}
      <aside className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col min-h-0">
        <div className="flex gap-1 mb-2 text-xs">
          {(
            [
              ["commands", "Command Stream"],
              ["hive", "Hive Mind"],
              ["memory", `Memory${system?.memories ? ` (${system.memories})` : ""}`],
            ] as [RightTab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setRightTab(key)}
              className={`px-2.5 py-1 rounded-md uppercase tracking-wider font-semibold whitespace-nowrap ${
                rightTab === key ? "bg-cyan-700 text-white" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          ref={telemetryRef}
          className="flex-1 min-h-0 bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono text-xs overflow-y-auto space-y-1 mb-4"
        >
          {rightTab === "commands" && (
            <>
              <div className="text-emerald-400">Jarvis telemetry online. Awaiting dispatch...</div>
              {statusEvents.map((e) => (
                <div key={e.eventId} className="text-slate-400">
                  <span className="text-cyan-500">[{new Date(e.timestamp).toLocaleTimeString()}]</span>{" "}
                  <span className="text-slate-500">{e.taskId.slice(0, 8)}</span> {e.source === "voice" ? "🎙 " : ""}
                  {e.source === "telegram" ? "✈ " : ""}
                  {e.activeSubAgent} → {e.status}
                </div>
              ))}
            </>
          )}
          {rightTab === "hive" &&
            (hive.length ? (
              hive.map((h, i) => (
                <div key={`${h.ts}-${i}`} className="text-slate-400">
                  <span className="text-cyan-500">[{new Date(h.ts).toLocaleTimeString()}]</span>{" "}
                  <span className="text-slate-200">{h.agent}</span> <span className="text-fuchsia-400">{h.event}</span>{" "}
                  <span className="text-slate-500">{h.summary}</span>
                </div>
              ))
            ) : (
              <div className="text-slate-600 italic">No team activity yet.</div>
            ))}
          {rightTab === "memory" && (
            <div className="space-y-2">
              <div className="flex gap-1">
                <input
                  value={newMemory}
                  onChange={(e) => setNewMemory(e.target.value)}
                  placeholder="Add a pinned memory..."
                  className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200"
                />
                <button
                  onClick={() => {
                    if (newMemory.trim()) void memoryAction("", { text: newMemory.trim(), pinned: true }).then(() => setNewMemory(""));
                  }}
                  className="px-2 bg-cyan-700 rounded text-white"
                >
                  Add
                </button>
                <button onClick={() => void memoryAction("/maintain")} className="px-2 bg-slate-800 rounded text-slate-300" title="Run decay and merge now">
                  Tidy
                </button>
              </div>
              {memories.length === 0 && <div className="text-slate-600 italic">No memories yet. They are saved after tasks finish.</div>}
              {memories.map((m) => (
                <div key={m.id} className="flex gap-2 items-start border-b border-slate-800 pb-1">
                  <div className="flex-1 text-slate-300">
                    {m.pinned ? "📌 " : ""}
                    {m.text}
                    <div className="text-[10px] text-slate-600">
                      {m.agent} · importance {m.importance.toFixed(2)} · used {m.hits}×
                    </div>
                  </div>
                  <button onClick={() => void memoryAction(`/${m.id}/${m.pinned ? "unpin" : "pin"}`)} className="text-slate-500 hover:text-slate-200">
                    {m.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button onClick={() => void memoryAction(`/${m.id}/delete`)} className="text-slate-500 hover:text-rose-400">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void handleRunTask();
            }}
            placeholder="Dispatch a task (Ctrl+Enter)..."
            className="w-full h-24 bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 resize-none focus:outline-none focus:border-cyan-500 font-mono"
          />
          {dispatchError && <p className="text-rose-400 text-xs font-mono">{dispatchError}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => void handleRunTask()}
              disabled={!prompt.trim() || connection !== "open"}
              className="flex-1 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-400 text-white font-medium py-2 rounded-lg transition-colors text-sm shadow-lg shadow-cyan-950/50"
            >
              Dispatch to Agent
            </button>
            <button
              onClick={() => void handleCancel()}
              disabled={!selectedActive}
              className="px-4 bg-rose-700 hover:bg-rose-600 disabled:bg-slate-800 disabled:text-slate-500 text-white font-medium py-2 rounded-lg transition-colors text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      </aside>
      </>)}
    </div>
  );
}
