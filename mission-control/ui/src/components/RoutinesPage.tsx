import { useEffect, useMemo, useState } from "react";
import { AGENT_LABELS, fileUrl, getJson, send } from "../api";
import type { CardFile } from "../api";

// Routines: a request plus a schedule. When one is due, Mission Control creates a
// read-only card for it and sends the result to the routine's one destination.

interface Routine {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  cron: string;
  label: string;
  targetAgent: string;
  deliverTo: "dashboard" | "telegram" | "obsidian";
  allowedSites: string[];
  enabled: boolean;
  catchUp: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: string;
  lastSkip?: string;
  runs: number;
  upcoming: number[];
}
interface Reply {
  routines: Routine[];
  timezone: string;
  minMinutes: number;
  deliveries: { telegram: boolean; obsidian: boolean };
}
interface Run {
  id: string;
  status: string;
  createdAt: number;
  finishedAt?: number;
  preview: string;
  files?: CardFile[];
}
type Draft = Pick<Routine, "name" | "prompt" | "schedule" | "targetAgent" | "deliverTo" | "enabled" | "catchUp"> & { sites: string; timezone: string };

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const AGENTS = ["auto", "planner", "browser", "coder", "file", "security_audit"];
const EXAMPLES = ["weekdays at 7:30am", "every 2 hours", "daily at 6pm", "mondays at 9am", "monthly on the 1st at 9:00", "every 30 minutes"];
const STATUS_STYLE: Record<string, string> = {
  complete: "bg-emerald-700/70 text-emerald-100",
  error: "bg-rose-700/70 text-rose-100",
  canceled: "bg-slate-700 text-slate-300",
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");

function when(t: number, tz: string) {
  return new Date(t).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function relative(t: number) {
  const m = Math.round((t - Date.now()) / 60000);
  const abs = Math.abs(m);
  const text = abs < 1 ? "now" : abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  return text === "now" ? text : m > 0 ? `in ${text}` : `${text} ago`;
}

function SchedulePreview({ schedule, timezone }: { schedule: string; timezone: string }) {
  const [out, setOut] = useState<{ label?: string; upcoming?: number[]; error?: string } | null>(null);
  useEffect(() => {
    if (!schedule.trim()) return setOut(null);
    const t = setTimeout(() => {
      send<{ label: string; upcoming: number[] }>("POST", "/api/routines/preview", { schedule, timezone })
        .then((r) => setOut(r))
        .catch((e) => setOut({ error: errText(e) }));
    }, 300);
    return () => clearTimeout(t);
  }, [schedule, timezone]);
  if (!out) return null;
  if (out.error) return <p className="text-[11px] text-rose-300">{out.error}</p>;
  return (
    <p className="text-[11px] text-slate-400">
      <span className="text-cyan-300">{out.label}</span> · next: {out.upcoming?.map((t) => when(t, timezone)).join(" · ")}
    </p>
  );
}

function RoutineForm({ initial, info, onSave, onCancel }: { initial: Draft; info: Reply; onSave: (d: Draft) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const input = "w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";
  return (
    <form
      className="bg-slate-900 border border-cyan-800/60 rounded-xl p-4 space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSave(d);
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Name</span>
          <input value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Morning AI news" className={input} required maxLength={80} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Schedule (time zone {d.timezone})</span>
          <input value={d.schedule} onChange={(e) => set("schedule", e.target.value)} placeholder="weekdays at 7:30am" className={input} required maxLength={100} />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5 -mt-1">
        {EXAMPLES.map((x) => (
          <button key={x} type="button" onClick={() => set("schedule", x)} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 hover:text-cyan-300">
            {x}
          </button>
        ))}
        <span className="text-[10px] text-slate-500 self-center">or five cron fields, like 30 7 * * 1-5 · at most every {info.minMinutes} minutes</span>
      </div>
      <SchedulePreview schedule={d.schedule} timezone={d.timezone} />
      <label className="block space-y-1">
        <span className="text-xs text-slate-400">What to do each time</span>
        <textarea
          value={d.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          rows={3}
          required
          maxLength={4000}
          placeholder="Open news.ycombinator.com and summarize the top 5 stories about AI, with links."
          className={`${input} resize-none`}
        />
      </label>
      <div className="grid grid-cols-3 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Agent</span>
          <select value={d.targetAgent} onChange={(e) => set("targetAgent", e.target.value)} className={input}>
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {a === "auto" ? "Auto-route" : AGENT_LABELS[a] ?? a}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Send the result to</span>
          <select value={d.deliverTo} onChange={(e) => set("deliverTo", e.target.value as Draft["deliverTo"])} className={input}>
            <option value="dashboard">Dashboard only</option>
            <option value="telegram" disabled={!info.deliveries.telegram}>
              Telegram{info.deliveries.telegram ? "" : " (not set up)"}
            </option>
            <option value="obsidian" disabled={!info.deliveries.obsidian}>
              Obsidian vault{info.deliveries.obsidian ? "" : " (not set up)"}
            </option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Sites it may open (comma-separated)</span>
          <input value={d.sites} onChange={(e) => set("sites", e.target.value)} placeholder="news.ycombinator.com" className={input} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} /> On
        </label>
        <label className="flex items-center gap-2" title="If the PC was off or asleep when it was due, run once when Mission Control is back">
          <input type="checkbox" checked={d.catchUp} onChange={(e) => set("catchUp", e.target.checked)} /> Catch up on a missed run
        </label>
        <span className="text-[11px] text-slate-500">Runs are read-only: pages can be opened and read, but nothing is typed, submitted or saved.</span>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white font-medium disabled:opacity-50">
            {busy ? "Saving…" : "Save routine"}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </form>
  );
}

function Runs({ id, tz }: { id: string; tz: string }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  useEffect(() => {
    getJson<Run[]>(`/api/routines/${id}/runs`).then(setRuns).catch(() => setRuns([]));
  }, [id]);
  if (!runs) return <p className="text-xs text-slate-500 px-1">Loading runs…</p>;
  if (!runs.length) return <p className="text-xs text-slate-500 px-1">No runs yet.</p>;
  return (
    <ul className="space-y-1.5">
      {runs.map((r) => (
        <li key={r.id} className="text-xs bg-slate-950 border border-slate-800 rounded-md px-3 py-2">
          <div className="flex items-center gap-2">
            <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${STATUS_STYLE[r.status] ?? "bg-sky-800/70 text-sky-100"}`}>{r.status}</span>
            <span className="text-slate-400">{when(r.createdAt, tz)}</span>
            {r.files?.map((f) => (
              <a key={f.name} href={fileUrl(f.name)} target="_blank" rel="noopener" className="text-cyan-300 hover:underline">
                📄 {f.name}
              </a>
            ))}
          </div>
          {r.preview && <p className="text-slate-400 mt-1 line-clamp-2">{r.preview}</p>}
        </li>
      ))}
    </ul>
  );
}

export default function RoutinesPage() {
  const [data, setData] = useState<Reply | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () =>
    getJson<Reply>("/api/routines")
      .then(setData)
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  const blank: Draft = useMemo(
    () => ({ name: "", prompt: "", schedule: "", targetAgent: "auto", deliverTo: "dashboard", enabled: true, catchUp: false, sites: "", timezone: BROWSER_TZ }),
    [],
  );
  const toBody = (d: Draft) => ({
    name: d.name,
    prompt: d.prompt,
    schedule: d.schedule,
    timezone: d.timezone,
    targetAgent: d.targetAgent,
    deliverTo: d.deliverTo,
    enabled: d.enabled,
    catchUp: d.catchUp,
    allowedSites: d.sites
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean),
  });
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
      await load();
    } catch (e) {
      setError(errText(e));
    }
  };

  if (!data) return <div className="col-span-3 p-6 text-slate-500">{error ?? "Loading routines…"}</div>;
  return (
    <div className="col-span-3 min-h-0 overflow-y-auto space-y-4 pr-1">
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-200">Routines</h2>
          <p className="text-xs text-slate-500">
            Requests that run on a schedule. Each run is a read-only card on the board, and its result goes to one place.
          </p>
          {editing === null && (
            <button onClick={() => setEditing("new")} className="ml-auto px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium">
              + New routine
            </button>
          )}
        </div>
        {message && <p className="text-xs text-emerald-300 mt-2">{message}</p>}
        {error && <p className="text-xs text-rose-300 mt-2">{error}</p>}
      </section>

      {editing === "new" && (
        <RoutineForm
          initial={blank}
          info={data}
          onCancel={() => setEditing(null)}
          onSave={async (d) => {
            await send("POST", "/api/routines", toBody(d));
            setEditing(null);
            setMessage(`Saved “${d.name}”.`);
            await load();
          }}
        />
      )}

      {data.routines.length === 0 && editing !== "new" && (
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-sm text-slate-400">
          No routines yet. Try one like “every weekday at 7:30am, summarize the top AI stories on news.ycombinator.com”.
        </section>
      )}

      {data.routines.map((r) =>
        editing === r.id ? (
          <RoutineForm
            key={r.id}
            initial={{ ...r, sites: r.allowedSites.join(", ") }}
            info={data}
            onCancel={() => setEditing(null)}
            onSave={async (d) => {
              await send("PATCH", `/api/routines/${r.id}`, toBody(d));
              setEditing(null);
              setMessage(`Saved “${d.name}”.`);
              await load();
            }}
          />
        ) : (
          <section key={r.id} className={`bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2 ${r.enabled ? "" : "opacity-60"}`}>
            <div className="flex items-center gap-3">
              <span className="text-lg">⏱</span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-100 truncate">{r.name}</h3>
                <p className="text-xs text-slate-400">
                  <span className="text-cyan-300">{r.label}</span>
                  {r.timezone !== BROWSER_TZ && <span> ({r.timezone})</span>} · {r.targetAgent === "auto" ? "Auto-route" : AGENT_LABELS[r.targetAgent] ?? r.targetAgent} ·{" "}
                  {r.deliverTo === "dashboard" ? "dashboard" : r.deliverTo === "telegram" ? "→ Telegram" : "→ Obsidian"}
                  {r.allowedSites.length > 0 && <span> · {r.allowedSites.join(", ")}</span>}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2 text-xs">
                <label className="flex items-center gap-1.5 text-slate-300" title={r.enabled ? "Turn off" : "Turn on"}>
                  <input type="checkbox" checked={r.enabled} onChange={(e) => void act(() => send("PATCH", `/api/routines/${r.id}`, { enabled: e.target.checked }))} />
                  On
                </label>
                <button onClick={() => void act(() => send("POST", `/api/routines/${r.id}/run`, {}), `“${r.name}” started; its card is on the board.`)} className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200">
                  ▶ Run now
                </button>
                <button onClick={() => setEditing(r.id)} className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300">
                  Edit
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete the routine “${r.name}”? Its past cards stay on the board.`)) void act(() => send("DELETE", `/api/routines/${r.id}`), `Deleted “${r.name}”.`);
                  }}
                  className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-rose-900 text-slate-400"
                >
                  Delete
                </button>
              </div>
            </div>
            <p className="text-xs text-slate-300 bg-slate-950/60 rounded-md px-3 py-2 whitespace-pre-wrap">{r.prompt}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
              <span>
                Next: {r.enabled && r.nextRunAt ? `${when(r.nextRunAt, r.timezone)} (${relative(r.nextRunAt)})` : "off"}
              </span>
              <span>
                Last:{" "}
                {r.lastRunAt ? (
                  <>
                    {relative(r.lastRunAt)}{" "}
                    {r.lastStatus && <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${STATUS_STYLE[r.lastStatus] ?? "bg-sky-800/70 text-sky-100"}`}>{r.lastStatus}</span>}
                  </>
                ) : (
                  "never"
                )}
              </span>
              <span>{r.runs} run{r.runs === 1 ? "" : "s"}</span>
              {r.lastSkip && <span className="text-amber-300">Last skipped: {r.lastSkip}</span>}
              <button onClick={() => setOpen(open === r.id ? null : r.id)} className="text-cyan-400 hover:text-cyan-300 ml-auto">
                {open === r.id ? "Hide runs" : "Show runs"}
              </button>
            </div>
            {open === r.id && <Runs id={r.id} tz={r.timezone} />}
          </section>
        ),
      )}
    </div>
  );
}
