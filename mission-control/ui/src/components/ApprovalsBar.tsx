import { useEffect, useRef, useState } from "react";
import { AGENT_LABELS, getJson, send } from "../api";
import { HARNESS_URL } from "../config";

// Actions waiting for your OK: an agent wants to type, submit or click something.
// Shown on every page (and in a card's drawer, for that card). Nothing happens until
// you answer; no answer in time counts as "no".

export interface PendingApproval {
  id: string;
  code: string;
  taskId: string;
  taskTitle: string;
  agent: string;
  kind: string;
  summary: string;
  url: string;
  risk: "normal" | "high";
  unattended: boolean;
  expiresAt: number;
  hasScreenshot: boolean;
}

const shotUrl = (id: string) => `${HARNESS_URL}/api/approvals/${id}/screenshot`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  return (
    <span className={s < 60 ? "text-rose-300" : "text-slate-400"}>
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")} left
    </span>
  );
}

function Request({ a, onDone }: { a: PendingApproval; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [big, setBig] = useState(false);
  const answer = async (approve: boolean, scope: "once" | "card" = "once") => {
    setBusy(true);
    setError(null);
    try {
      await send("POST", `/api/approvals/${a.id}`, { approve, scope, note: note.trim() || undefined });
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`flex gap-3 rounded-lg border p-3 ${a.risk === "high" ? "border-rose-500/70 bg-rose-950/40" : "border-amber-500/60 bg-amber-950/30"}`}>
      {a.hasScreenshot && (
        <button type="button" onClick={() => setBig((v) => !v)} className="shrink-0" title={big ? "Smaller" : "Bigger"}>
          <img src={shotUrl(a.id)} alt="The page, with the target outlined" className={`${big ? "w-[640px]" : "w-48"} rounded border border-slate-700`} />
        </button>
      )}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-amber-300">⏸</span>
          <span className="text-slate-100">
            <b>{AGENT_LABELS[a.agent] ?? a.agent}</b> wants to {a.summary}
          </span>
          {a.risk === "high" && <span className="px-1.5 py-0.5 rounded bg-rose-700 text-white text-[10px] font-semibold">HIGH RISK</span>}
          {a.unattended && <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-200 text-[10px]">routine</span>}
        </div>
        <p className="text-[11px] text-slate-400 truncate">
          Card: {a.taskTitle} · <span title={a.url}>{a.url}</span> · <Countdown until={a.expiresAt} /> · code {a.code}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button disabled={busy} onClick={() => void answer(true)} className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50">
            Approve
          </button>
          {a.risk === "normal" && !a.unattended && (
            <button
              disabled={busy}
              onClick={() => void answer(true, "card")}
              className="px-3 py-1.5 rounded-md bg-emerald-900 hover:bg-emerald-800 text-emerald-100 disabled:opacity-50"
              title="Also approve this kind of action on this site for the rest of this card"
            >
              Approve for this card on this site
            </button>
          )}
          <button disabled={busy} onClick={() => void answer(false)} className="px-3 py-1.5 rounded-md bg-slate-700 hover:bg-rose-800 text-slate-100 disabled:opacity-50">
            Deny
          </button>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for the agent (e.g. why not)"
            maxLength={200}
            className="flex-1 min-w-[180px] bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
          />
        </div>
        {error && <p className="text-[11px] text-rose-300">{error}</p>}
      </div>
    </div>
  );
}

export default function ApprovalsBar({ taskId }: { taskId?: string }) {
  const [list, setList] = useState<PendingApproval[]>([]);
  const baseTitle = useRef(document.title);
  const load = () =>
    getJson<{ pending: PendingApproval[] }>("/api/approvals")
      .then((d) => setList(d.pending))
      .catch(() => {});
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, []);
  // The tab title shows waiting requests, so they're noticed from other tabs
  useEffect(() => {
    if (taskId) return;
    document.title = list.length ? `⏸ (${list.length}) Approval needed · ${baseTitle.current}` : baseTitle.current;
  }, [list.length, taskId]);
  const shown = taskId ? list.filter((a) => a.taskId === taskId) : list;
  if (!shown.length) return null;
  return (
    <div className="space-y-2">
      {shown.map((a) => (
        <Request key={a.id} a={a} onDone={() => void load()} />
      ))}
    </div>
  );
}
