import { useEffect, useState } from "react";
import { AGENT_LABELS, getJson, send } from "../api";

// Team page section: what agents may do without asking, and the record of answers.

type Mode = "ask" | "allow" | "block";
interface Policy {
  type: Mode;
  submit: Mode;
  click: Mode;
  search: Mode;
  timeoutMinutes: number;
}
interface Decided {
  id: string;
  agent: string;
  summary: string;
  status: string;
  decidedBy?: string;
  scope?: string;
  risk: string;
  taskTitle: string;
  createdAt: number;
  note?: string;
}

const ROWS: { key: keyof Omit<Policy, "timeoutMinutes">; label: string; hint: string }[] = [
  { key: "type", label: "Typing into a page", hint: "Filling in a field without submitting" },
  { key: "submit", label: "Submitting a form", hint: "Pressing Enter or a submit button: sends what was typed" },
  { key: "click", label: "Clicking a button", hint: "Buttons, menus and script links (plain links never ask)" },
  { key: "search", label: "Searching a site", hint: "Typing into a search box and searching" },
];
const STATUS: Record<string, string> = {
  approved: "text-emerald-300",
  denied: "text-rose-300",
  expired: "text-amber-300",
  canceled: "text-slate-500",
};

export default function ApprovalsSettings() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [history, setHistory] = useState<Decided[]>([]);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = () =>
    getJson<{ policy: Policy; history: Decided[] }>("/api/approvals")
      .then((d) => {
        setPolicy((p) => (dirty && p ? p : d.policy));
        setHistory(d.history);
      })
      .catch(() => {});
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [dirty]);
  if (!policy) return null;
  const set = (patch: Partial<Policy>) => {
    setPolicy({ ...policy, ...patch });
    setDirty(true);
    setMessage(null);
  };
  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-slate-200">Approvals</h2>
        <p className="text-xs text-slate-500">
          What agents may do on web pages without asking you. Read-only runs never act; routines that may act always ask.
        </p>
        <button
          disabled={!dirty}
          onClick={async () => {
            try {
              setPolicy(await send<Policy>("PUT", "/api/approvals/policy", policy));
              setDirty(false);
              setMessage("Saved.");
            } catch (e) {
              setMessage(e instanceof Error ? e.message : String(e));
            }
          }}
          className="ml-auto px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium disabled:opacity-40"
        >
          Save
        </button>
      </div>
      {message && <p className="text-xs text-emerald-300">{message}</p>}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        {ROWS.map((r) => (
          <div key={r.key} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-200">{r.label}</p>
              <p className="text-[10px] text-slate-500">{r.hint}</p>
            </div>
            <div className="flex gap-1">
              {(["ask", "allow", "block"] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => set({ [r.key]: m } as Partial<Policy>)}
                  className={`px-2.5 py-1 rounded text-[11px] capitalize ${
                    policy[r.key] === m ? (m === "allow" ? "bg-emerald-700 text-white" : m === "block" ? "bg-rose-800 text-white" : "bg-amber-600 text-white") : "bg-slate-800 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
        <label className="flex items-center gap-2">
          Wait for an answer for
          <input
            type="number"
            min={1}
            max={240}
            value={policy.timeoutMinutes}
            onChange={(e) => set({ timeoutMinutes: Math.min(240, Math.max(1, Number(e.target.value) || 15)) })}
            className="w-16 bg-slate-950 border border-slate-700 rounded px-2 py-1"
          />
          minutes (then it counts as no)
        </label>
        <span className="text-[11px] text-slate-500">
          Always, whatever these say: passwords, payment, bank and ID numbers and one-time codes are never typed, and buy, pay, transfer or delete buttons always ask.
        </span>
      </div>
      {history.length > 0 && (
        <details>
          <summary className="text-xs text-cyan-400 cursor-pointer">Recent answers ({history.length})</summary>
          <ul className="mt-2 space-y-1 max-h-64 overflow-y-auto">
            {history.map((h) => (
              <li key={h.id} className="text-[11px] text-slate-400 flex gap-2">
                <span className="text-slate-500 shrink-0">{new Date(h.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                <span className={`shrink-0 uppercase ${STATUS[h.status] ?? ""}`}>{h.status}</span>
                <span className="truncate">
                  {AGENT_LABELS[h.agent] ?? h.agent}: {h.summary}
                  {h.risk === "high" ? " ⚠" : ""} · {h.decidedBy === "policy" ? "by your settings" : h.decidedBy === "card-grant" ? "covered by an earlier OK" : h.decidedBy ?? ""}
                  {h.note ? ` · “${h.note}”` : ""} · {h.taskTitle}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
