import { useEffect, useState } from "react";
import { getJson, send } from "../api";

// File changes the agents made, with diffs and Undo / Redo. Used on a card and on the
// Files page.

interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  added: number;
  removed: number;
}
interface DiffLine {
  op: " " | "+" | "-";
  text: string;
  a?: number;
  b?: number;
}
interface Hunk {
  aStart: number;
  aLines: number;
  bStart: number;
  bLines: number;
  lines: DiffLine[];
}
export interface ChangeSummary {
  id: string;
  at: number;
  taskId?: string;
  taskTitle?: string;
  label: string;
  where: string;
  files: FileChange[];
  by: "agent" | "user";
  undoes?: string;
  undoneBy?: string;
}
interface Detail extends ChangeSummary {
  files: (FileChange & { hunks: Hunk[]; tooBig: boolean })[];
  conflicts: string[];
}

const when = (t: number) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Diff({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getJson<Detail>(`/api/changes/${id}`)
      .then(setD)
      .catch((e) => setError(String(e)));
  }, [id]);
  if (error) return <p className="text-xs text-rose-300">{error}</p>;
  if (!d) return <p className="text-xs text-slate-500">Loading the diff…</p>;
  return (
    <div className="space-y-2">
      {d.conflicts.length > 0 && !d.undoneBy && (
        <p className="text-[11px] text-amber-300">Changed since: {d.conflicts.join(", ")}. Undoing puts back the earlier version over those later edits (they stay in the history).</p>
      )}
      {d.files.map((f) => (
        <div key={f.path} className="border border-slate-800 rounded-md overflow-hidden">
          <div className="px-2 py-1 bg-slate-800/70 text-[11px] font-mono text-slate-200 flex gap-2">
            <span className="truncate">{f.path}</span>
            <span className="ml-auto text-emerald-400">+{f.added}</span>
            <span className="text-rose-400">−{f.removed}</span>
            {f.before === null && <span className="text-slate-400">new</span>}
            {f.after === null && <span className="text-slate-400">deleted</span>}
          </div>
          {f.tooBig ? (
            <p className="px-2 py-1 text-[11px] text-slate-500">Too large to show.</p>
          ) : (
            <pre className="text-[11px] leading-snug font-mono overflow-x-auto max-h-80">
              {f.hunks.map((h, i) => (
                <div key={i}>
                  <div className="px-2 text-cyan-400/70 bg-slate-900">
                    @@ −{h.aStart},{h.aLines} +{h.bStart},{h.bLines} @@
                  </div>
                  {h.lines.map((l, j) => (
                    <div key={j} className={`px-2 whitespace-pre ${l.op === "+" ? "bg-emerald-950/70 text-emerald-200" : l.op === "-" ? "bg-rose-950/70 text-rose-200" : "text-slate-400"}`}>
                      <span className="inline-block w-8 text-right pr-2 text-slate-600 select-none">{l.op === "+" ? l.b : l.a}</span>
                      {l.op}
                      {l.text}
                    </div>
                  ))}
                </div>
              ))}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

/** A list of change sets with diffs and Undo / Redo buttons. */
export default function ChangeList({ list, onChanged, showCard }: { list: ChangeSummary[]; onChanged: () => void; showCard?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const undo = async (c: ChangeSummary) => {
    setBusy(c.id);
    setError(null);
    try {
      try {
        await send("POST", `/api/changes/${c.id}/undo`, {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/^Changed since/.test(msg)) throw e;
        if (!confirm(`${msg}\n\nThe later edits are kept in the history, so you can get them back.`)) return;
        await send("POST", `/api/changes/${c.id}/undo`, { force: true });
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  if (!list.length) return null;
  return (
    <div className="space-y-1.5">
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {list.map((c) => {
        const isUndo = Boolean(c.undoes);
        const added = c.files.reduce((n, f) => n + f.added, 0);
        const removed = c.files.reduce((n, f) => n + f.removed, 0);
        return (
          <div key={c.id} className={`border border-slate-800 rounded-lg p-2 ${c.undoneBy ? "opacity-60" : ""}`}>
            <div className="flex items-center gap-2 text-xs">
              <button onClick={() => setOpen(open === c.id ? null : c.id)} className="text-slate-400 hover:text-slate-200 w-4" aria-label="Show the diff">
                {open === c.id ? "▾" : "▸"}
              </button>
              <span className="text-base">{isUndo ? (c.label.startsWith("Redo") ? "↪" : "↩") : c.where === "your vault" ? "🗒" : "📝"}</span>
              <div className="min-w-0 flex-1">
                <div className="text-slate-200 truncate">
                  {c.label}
                  {c.undoneBy && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">undone</span>}
                </div>
                <div className="text-[10px] text-slate-500 truncate">
                  {when(c.at)} · {c.files.length} file{c.files.length === 1 ? "" : "s"} in {c.where} · <span className="text-emerald-500">+{added}</span> <span className="text-rose-500">−{removed}</span>
                  {showCard && c.taskTitle ? ` · from “${c.taskTitle}”` : ""}
                </div>
              </div>
              {!c.undoneBy && (
                <button onClick={() => void undo(c)} disabled={busy === c.id} className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-50 shrink-0">
                  {busy === c.id ? "…" : isUndo ? (c.label.startsWith("Undo") ? "Redo" : "Undo") : "Undo"}
                </button>
              )}
            </div>
            {open === c.id && (
              <div className="mt-2">
                <Diff id={c.id} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
