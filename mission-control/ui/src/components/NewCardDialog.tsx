import { useState } from "react";
import { AGENT_LABELS, BoardCard, send } from "../api";

// Form for a new card (also reused for editing a card in Backlog or Ready).

export interface CardFields {
  title: string;
  prompt: string;
  targetAgent: string;
  priority: "low" | "normal" | "high";
  dependsOn: string[];
  needsReview: boolean;
  readOnly: boolean;
  allowedSites: string[];
}

export function CardForm({
  initial,
  cards,
  selfId,
  submitLabel,
  onSubmit,
  onCancel,
  extra,
}: {
  initial: CardFields;
  cards: BoardCard[];
  selfId?: string;
  submitLabel: string;
  onSubmit: (f: CardFields) => Promise<void>;
  onCancel: () => void;
  extra?: React.ReactNode;
}) {
  const [f, setF] = useState<CardFields>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof CardFields>(k: K, v: CardFields[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const candidates = cards.filter((c) => c.id !== selfId && c.column !== "failed").sort((a, b) => b.createdAt - a.createdAt);

  const submit = async () => {
    if (!f.prompt.trim()) return setError("Describe the task.");
    setBusy(true);
    try {
      await onSubmit(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const input = "w-full bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";
  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="text-xs text-slate-400">Title (optional)</span>
        <input className={input} value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Short name for the card" maxLength={200} />
      </label>
      <label className="block">
        <span className="text-xs text-slate-400">Task</span>
        <textarea
          className={`${input} h-28 resize-y font-mono text-[13px]`}
          value={f.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
          }}
          placeholder="What should the agent do? (Ctrl+Enter to save)"
          autoFocus
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-slate-400">Agent</span>
          <select className={input} value={f.targetAgent} onChange={(e) => set("targetAgent", e.target.value)}>
            {["auto", "planner", "coder", "browser", "file", "security_audit"].map((k) => (
              <option key={k} value={k}>
                {AGENT_LABELS[k]}
                {k === "planner" ? " (can delegate)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Priority</span>
          <select className={input} value={f.priority} onChange={(e) => set("priority", e.target.value as CardFields["priority"])}>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-slate-400">Waits for (runs only after these are done)</span>
        <select
          multiple
          className={`${input} h-24`}
          value={f.dependsOn}
          onChange={(e) => set("dependsOn", [...e.target.selectedOptions].map((o) => o.value).slice(0, 10))}
        >
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              [{c.column}] {c.title || c.prompt.slice(0, 60)}
            </option>
          ))}
        </select>
        <span className="text-[10px] text-slate-600">Ctrl/Cmd-click to pick several.</span>
      </label>
      <label className="flex items-center gap-2 text-slate-300 cursor-pointer select-none">
        <input type="checkbox" checked={f.needsReview} onChange={(e) => set("needsReview", e.target.checked)} />
        I'll review the result before it counts as done
      </label>
      <div>
        <label className="flex items-center gap-2 text-slate-300 cursor-pointer select-none">
          <input type="checkbox" checked={f.readOnly} onChange={(e) => set("readOnly", e.target.checked)} />
          Read-only run: look, don't touch
        </label>
        {f.readOnly && (
          <div className="ml-6 mt-1.5 space-y-1">
            <input
              className={input}
              value={f.allowedSites.join(", ")}
              onChange={(e) =>
                set(
                  "allowedSites",
                  e.target.value
                    .split(/[\s,]+/)
                    .map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
                    .filter(Boolean)
                    .slice(0, 10),
                )
              }
              placeholder="Sites it may open, e.g. example.com (blank: sites named in the task)"
            />
            <p className="text-[10px] text-slate-500">
              Fresh browser profile (never logged in), links only on these sites, no typing, buttons or form submits, no notes or memories saved.
            </p>
          </div>
        )}
      </div>
      {extra}
      {error && <p className="text-rose-300 text-xs">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-md bg-slate-800 text-slate-300 hover:bg-slate-700">
          Cancel
        </button>
        <button onClick={() => void submit()} disabled={busy} className="px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white font-medium disabled:opacity-50">
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

export default function NewCardDialog({
  column,
  cards,
  onClose,
  onCreated,
}: {
  column: "backlog" | "ready";
  cards: BoardCard[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [where, setWhere] = useState(column);
  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-xl p-5 shadow-2xl">
        <h2 className="text-base font-semibold text-slate-100 mb-3">New card</h2>
        <CardForm
          initial={{ title: "", prompt: "", targetAgent: "auto", priority: "normal", dependsOn: [], needsReview: false, readOnly: false, allowedSites: [] }}
          cards={cards}
          submitLabel={where === "ready" ? "Add & queue" : "Add to Backlog"}
          onCancel={onClose}
          onSubmit={async (f) => {
            await send("POST", "/api/tasks", { ...f, title: f.title || undefined, column: where });
            onCreated();
          }}
          extra={
            <div className="flex gap-4 text-slate-300">
              {(["ready", "backlog"] as const).map((w) => (
                <label key={w} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="radio" checked={where === w} onChange={() => setWhere(w)} />
                  {w === "ready" ? "Queue now (Ready)" : "Park in Backlog"}
                </label>
              ))}
            </div>
          }
        />
      </div>
    </div>
  );
}
