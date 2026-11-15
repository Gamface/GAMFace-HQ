import { useCallback, useEffect, useState } from "react";
import { AGENT_COLORS, AGENT_LABELS, getJson, send, splitModel } from "../api";
import type { Board as BoardData, BoardCard } from "../api";
import CardDrawer from "./CardDrawer";
import NewCardDialog from "./NewCardDialog";

// Kanban board. Drag cards between columns:
//   Backlog ⇄ Ready (queue / park)   Review → Done (accept)   Failed/Done → Ready (retry)
// Drop a card onto another card in the same column to reorder.

const COLUMN_INFO: Record<BoardCard["column"], { label: string; hint: string; accent: string }> = {
  backlog: { label: "Backlog", hint: "Parked. Drag to Ready to queue.", accent: "border-t-slate-500" },
  ready: { label: "Ready", hint: "Queued. Runs one at a time, by priority and order.", accent: "border-t-cyan-500" },
  running: { label: "Running", hint: "Working now.", accent: "border-t-amber-500" },
  review: { label: "Review", hint: "Finished; waiting for you to accept.", accent: "border-t-fuchsia-500" },
  done: { label: "Done", hint: "", accent: "border-t-emerald-500" },
  failed: { label: "Failed", hint: "Errors, cancels and interrupted runs. Drag to Ready to retry.", accent: "border-t-rose-500" },
};

const PRIORITY_STYLE = { high: "bg-rose-700 text-white", normal: "", low: "bg-slate-700 text-slate-300" };

export default function Board() {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newIn, setNewIn] = useState<"backlog" | "ready" | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(false);

  const load = useCallback(() => {
    getJson<BoardData>("/api/board")
      .then((b) => {
        setBoard(b);
        setError((e) => (e?.startsWith("Board") ? null : e));
      })
      .catch(() => setError("Board unavailable: is the harness running?"));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    load();
  };

  const cards = board?.cards ?? [];
  const byId = new Map(cards.map((c) => [c.id, c]));

  const dropOnColumn = (target: BoardCard["column"], beforeCard?: BoardCard) => {
    const card = dragId ? byId.get(dragId) : undefined;
    setDragId(null);
    if (!card) return;
    const from = card.column;
    if (from === target) {
      if (!beforeCard || beforeCard.id === card.id || (target !== "backlog" && target !== "ready")) return;
      // Reorder: land just before the card it was dropped on
      const col = cards.filter((c) => c.column === target);
      const idx = col.findIndex((c) => c.id === beforeCard.id);
      const prev = col[idx - 1];
      const position = prev ? ((prev.position ?? prev.createdAt) + (beforeCard.position ?? beforeCard.createdAt)) / 2 : (beforeCard.position ?? beforeCard.createdAt) - 1000;
      return act(() => send("PATCH", `/api/tasks/${card.id}`, { position }));
    }
    if ((from === "backlog" && target === "ready") || (from === "ready" && target === "backlog")) {
      return act(() => send("PATCH", `/api/tasks/${card.id}`, { column: target }));
    }
    if (from === "review" && target === "done") return act(() => send("POST", `/api/tasks/${card.id}/accept`));
    if ((from === "failed" || from === "done" || from === "review") && target === "ready") return act(() => send("POST", `/api/tasks/${card.id}/retry`));
    if (from === "running") return setError("A running card can't be moved. Open it to cancel.");
    setError(`Cards can't move from ${COLUMN_INFO[from].label} to ${COLUMN_INFO[target].label}.`);
  };

  const columns = (board?.columns ?? ["backlog", "ready", "running", "review", "done", "failed"]).filter((c) => !(hideDone && c === "done"));

  return (
    <div className="col-span-3 flex flex-col min-h-0 gap-3">
      <div className="flex items-center gap-3 text-xs">
        <button onClick={() => setNewIn("ready")} className="px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white font-medium">
          + New card
        </button>
        <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer select-none">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide Done
        </label>
        <span className="text-slate-500">Drag cards between columns. Drop on a card to reorder.</span>
        {error && (
          <span className="ml-auto text-rose-300 bg-rose-950/60 border border-rose-900 rounded px-2 py-1">
            {error}{" "}
            <button onClick={() => setError(null)} className="ml-1 text-rose-400">
              ✕
            </button>
          </span>
        )}
      </div>
      <div className={`grid gap-3 flex-1 min-h-0`} style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((col) => {
          const list = cards.filter((c) => c.column === col);
          if (col === "done" || col === "failed") list.sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
          return (
            <section
              key={col}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dropOnColumn(col)}
              className={`bg-slate-900 border border-slate-800 border-t-2 ${COLUMN_INFO[col].accent} rounded-xl flex flex-col min-h-0 ${dragId ? "ring-1 ring-slate-700" : ""}`}
            >
              <header className="px-3 pt-3 pb-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-xs uppercase tracking-wider font-semibold text-slate-300">{COLUMN_INFO[col].label}</h2>
                  <span className="text-[10px] text-slate-500 bg-slate-800 rounded px-1.5">{list.length}</span>
                  {(col === "backlog" || col === "ready") && (
                    <button onClick={() => setNewIn(col)} className="ml-auto text-slate-500 hover:text-cyan-300 text-sm" title={`Add to ${COLUMN_INFO[col].label}`}>
                      +
                    </button>
                  )}
                </div>
                {COLUMN_INFO[col].hint && <p className="text-[10px] text-slate-600 mt-0.5">{COLUMN_INFO[col].hint}</p>}
              </header>
              <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-2">
                {list.map((c) => (
                  <Card
                    key={c.id}
                    card={c}
                    byId={byId}
                    onOpen={() => setOpenId(c.id)}
                    onDragStart={() => setDragId(c.id)}
                    onDropOn={() => dropOnColumn(col, c)}
                    dragging={dragId === c.id}
                  />
                ))}
                {list.length === 0 && <p className="text-[11px] text-slate-700 italic px-1 py-4 text-center">Empty</p>}
              </div>
            </section>
          );
        })}
      </div>
      {newIn && <NewCardDialog column={newIn} cards={cards} onClose={() => setNewIn(null)} onCreated={() => { setNewIn(null); load(); }} />}
      {openId && <CardDrawer id={openId} cards={cards} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

function Card({
  card: c,
  byId,
  onOpen,
  onDragStart,
  onDropOn,
  dragging,
}: {
  card: BoardCard;
  byId: Map<string, BoardCard>;
  onOpen: () => void;
  onDragStart: () => void;
  onDropOn: () => void;
  dragging: boolean;
}) {
  const model = splitModel(c.plannedModel);
  const subsDone = c.subtasks.filter((s) => s.status === "complete").length;
  const waitingTitles = c.waitingOn.map((id) => byId.get(id)?.title ?? id.slice(0, 8));
  return (
    <article
      draggable={c.column !== "running"}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.stopPropagation();
        onDropOn();
      }}
      onClick={onOpen}
      className={`group bg-slate-950 border rounded-lg p-2.5 cursor-pointer hover:border-slate-600 transition ${
        c.column === "running" ? "border-amber-700/70 shadow-[0_0_0_1px_rgba(217,119,6,0.25)]" : "border-slate-800"
      } ${dragging ? "opacity-40" : ""}`}
    >
      <div className="flex items-start gap-1.5">
        {c.column === "running" && <span className="mt-1 h-2 w-2 rounded-full bg-amber-400 animate-pulse shrink-0" />}
        <p className="text-[13px] leading-snug text-slate-200 line-clamp-2 flex-1">{c.title || c.prompt}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1 mt-2 text-[10px]">
        <span className={`px-1.5 py-0.5 rounded ${AGENT_COLORS[c.targetAgent] ?? "bg-slate-800 text-slate-300"}`}>
          {c.routedBy === undefined && c.column !== "done" && c.column !== "failed" ? "auto" : AGENT_LABELS[c.targetAgent] ?? c.targetAgent}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono truncate max-w-[9rem]" title={c.plannedModel ?? "chosen when routed"}>
          {model.provider && model.provider !== "ollama" ? "☁ " : ""}
          {model.name}
        </span>
        {c.priority && c.priority !== "normal" && <span className={`px-1.5 py-0.5 rounded uppercase ${PRIORITY_STYLE[c.priority]}`}>{c.priority}</span>}
        {c.needsReview && <span className="px-1.5 py-0.5 rounded bg-fuchsia-900/70 text-fuchsia-200">review</span>}
        {c.readOnly && <span className="px-1.5 py-0.5 rounded bg-sky-900/70 text-sky-200" title="Read-only run">👁 read-only</span>}
        {c.usedPrivate && <span title="Used your private notes, memories or pictures">🔒</span>}
        {(c.documents?.length ?? 0) > 0 && <span title={`${c.documents!.length} PDF(s) attached`}>📑{c.documents!.length > 1 ? c.documents!.length : ""}</span>}
        {(c.files?.length ?? 0) > 0 && <span title={`${c.files!.length} PDF report(s)`}>📄{c.files!.length > 1 ? c.files!.length : ""}</span>}
        {(c.replies ?? 0) > 0 && <span title={`${c.replies} repl${c.replies === 1 ? "y" : "ies"}`}>💬{c.replies}</span>}
        {c.audio && c.audio.length > 0 && <span title={`${c.audio.length} audio clip(s) attached`}>🎧{c.audio.length > 1 ? c.audio.length : ""}</span>}
        {c.images && c.images.length > 0 && <span title={`${c.images.length} picture(s) attached`}>🖼{c.images.length > 1 ? c.images.length : ""}</span>}
        {c.source === "telegram" && <span title="From Telegram">✈</span>}
        {c.source === "routine" && <span title={`Routine run: always read-only. Result goes to: ${c.deliverTo ?? "dashboard"}`}>⏱</span>}
        {c.source === "voice" && <span title="Spoken">🎙</span>}
      </div>
      {waitingTitles.length > 0 && (
        <p className="mt-1.5 text-[10px] text-amber-300/90 truncate" title={waitingTitles.join(", ")}>
          ⏳ waiting on {waitingTitles.join(", ")}
        </p>
      )}
      {c.subtasks.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-400">
          <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden">
            <div className="h-full bg-cyan-600" style={{ width: `${(100 * subsDone) / c.subtasks.length}%` }} />
          </div>
          {subsDone}/{c.subtasks.length} handoffs
        </div>
      )}
      {c.interrupted && <p className="mt-1.5 text-[10px] text-amber-300">⚠ interrupted by a restart</p>}
      {c.preview && (c.column === "done" || c.column === "review" || c.column === "failed") && (
        <p className={`mt-1.5 text-[11px] line-clamp-2 ${c.column === "failed" ? "text-rose-300/80" : "text-slate-500"}`}>{c.preview}</p>
      )}
    </article>
  );
}
