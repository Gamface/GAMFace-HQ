import { useEffect, useRef, useState } from "react";
import { AGENT_COLORS, AGENT_LABELS, getJson, imageUrl, send, splitModel, uploadUrl } from "../api";
import type { BoardCard } from "../api";
import { CardForm } from "./NewCardDialog";
import PreviewPane from "./PreviewPane";
import ReplyBox from "./ReplyBox";
import FilesBar from "./FilesBar";
import { DocChip } from "./DocAttach";
import type { CardFile, DocInfo } from "../api";

// Side panel for one card: what it is, where it stands, its handoffs and output,
// and the actions that make sense for its column.

interface Detail {
  id: string;
  title?: string;
  prompt: string;
  targetAgent: string;
  routedBy?: string;
  status: string;
  model: string;
  plannedModel: string | null;
  priority?: "low" | "normal" | "high";
  dependsOn?: string[];
  waitingOn: string[];
  needsReview?: boolean;
  readOnly?: boolean;
  allowedSites?: string[];
  usedPrivate?: boolean;
  images?: string[];
  audio?: string[];
  documents?: string[];
  thread?: { role: "user" | "agent"; text: string }[];
  reply?: string;
  acceptedAt?: number;
  interrupted?: boolean;
  attempts?: number;
  error?: string;
  answer?: string;
  files?: CardFile[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  subtasks: { id: string; title?: string; targetAgent: string; status: string; model: string; answer?: string; error?: string }[];
  events: { logChunk: string }[];
}

const RUNNING = ["routing", "thinking", "delegating", "streaming", "executing_tool", "writing_diff"];

function columnOf(d: Detail): BoardCard["column"] {
  if (d.status === "backlog" || d.status === "idle") return "backlog";
  if (d.status === "queued") return "ready";
  if (d.status === "complete") return d.needsReview && !d.acceptedAt ? "review" : "done";
  if (d.status === "error" || d.status === "canceled") return "failed";
  return "running";
}

export default function CardDrawer({ id, cards, onClose, onChanged }: { id: string; cards: BoardCard[]; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState<"output" | "preview">("output");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const outRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getJson<Detail>(`/api/tasks/${id}`)
        .then((x) => alive && setD(x))
        .catch(() => alive && setError("This card no longer exists."));
    load();
    const timer = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);

  useEffect(() => {
    if (outRef.current && d && RUNNING.includes(d.status)) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [d?.events.length]);

  const act = async (fn: () => Promise<unknown>, close = false) => {
    try {
      await fn();
      setError(null);
      onChanged();
      if (close) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const col = d ? columnOf(d) : null;
  const output = d ? d.events.map((e) => e.logChunk).join("") : "";
  const model = splitModel(d?.model || d?.plannedModel);
  const titleOf = (cid: string) => cards.find((c) => c.id === cid)?.title ?? cid.slice(0, 8);
  const btn = "px-3 py-1.5 rounded-md text-xs font-medium";

  return (
    <div className="fixed inset-0 z-30 bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="absolute right-0 top-0 h-full w-full max-w-2xl bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col">
        <header className="px-5 py-4 border-b border-slate-800">
          <div className="flex items-start gap-3">
            <h2 className="flex-1 text-base font-semibold text-slate-100 leading-snug">{d?.title || d?.prompt || "…"}</h2>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">
              ✕
            </button>
          </div>
          {d && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2 text-[11px]">
              <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 uppercase tracking-wide">{col}</span>
              <span className={`px-2 py-0.5 rounded ${AGENT_COLORS[d.targetAgent] ?? "bg-slate-800"}`}>
                {AGENT_LABELS[d.targetAgent]}
                {d.routedBy === "router" || d.routedBy === "keywords" ? " (auto-routed)" : d.routedBy === undefined ? " (auto)" : ""}
              </span>
              <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                {model.provider && model.provider !== "ollama" ? "☁ " : ""}
                {d.model || d.plannedModel || "model chosen when routed"}
              </span>
              {d.priority && d.priority !== "normal" && <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 uppercase">{d.priority}</span>}
              {(d.thread?.length ?? 0) > 0 && (
                <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300" title="Replies in this conversation">
                  💬 {d.thread!.length / 2} {d.thread!.length / 2 === 1 ? "reply" : "replies"}
                </span>
              )}
              {(d.attempts ?? 0) > 1 && <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400">attempt {d.attempts}</span>}
              {d.readOnly && (
                <span className="px-2 py-0.5 rounded bg-sky-900/70 text-sky-200" title={`May open: ${(d.allowedSites ?? []).join(", ") || "sites named in the task"}`}>
                  👁 read-only
                </span>
              )}
              {d.usedPrivate && (
                <span className="px-2 py-0.5 rounded bg-emerald-900/60 text-emerald-200" title="Used your vault notes or memories; never sent to a cloud model unless you allowed it">
                  🔒 private context
                </span>
              )}
              {d.startedAt && d.finishedAt && <span className="text-slate-500">{((d.finishedAt - d.startedAt) / 1000).toFixed(1)}s</span>}
            </div>
          )}
          {d && d.waitingOn.length > 0 && <p className="mt-2 text-xs text-amber-300">⏳ Waiting on: {d.waitingOn.map(titleOf).join(", ")}</p>}
          {d?.documents && d.documents.length > 0 && <DocChips ids={d.documents} />}
          {d?.audio && d.audio.length > 0 && (
            <div className="flex flex-col gap-1">
              {d.audio.map((id, i) => (
                <div key={id} className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400">🎧 clip {i + 1}</span>
                  <audio src={uploadUrl(id)} controls preload="none" className="h-7 w-64" />
                </div>
              ))}
            </div>
          )}
          {d?.images && d.images.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {d.images.map((id) => (
                <a key={id} href={imageUrl(id)} target="_blank" rel="noreferrer" title="Open full size">
                  <img src={imageUrl(id)} alt="attached picture" className="h-20 w-20 object-cover rounded border border-slate-700 hover:border-cyan-500" />
                </a>
              ))}
            </div>
          )}
          {d?.interrupted && <p className="mt-2 text-xs text-amber-300">⚠ A restart cut this run short. Retry to run it again.</p>}
          {d && (
            <div className="flex flex-wrap gap-2 mt-3">
              {col === "backlog" && (
                <button className={`${btn} bg-cyan-600 hover:bg-cyan-500 text-white`} onClick={() => act(() => send("PATCH", `/api/tasks/${id}`, { column: "ready" }))}>
                  ▶ Queue
                </button>
              )}
              {col === "ready" && (
                <button className={`${btn} bg-slate-700 hover:bg-slate-600 text-slate-200`} onClick={() => act(() => send("PATCH", `/api/tasks/${id}`, { column: "backlog" }))}>
                  Move to Backlog
                </button>
              )}
              {(col === "backlog" || col === "ready") && !editing && (
                <button className={`${btn} bg-slate-700 hover:bg-slate-600 text-slate-200`} onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
              {col === "review" && (
                <button className={`${btn} bg-emerald-600 hover:bg-emerald-500 text-white`} onClick={() => act(() => send("POST", `/api/tasks/${id}/accept`))}>
                  ✓ Accept
                </button>
              )}
              {(col === "failed" || col === "review" || col === "done") && (
                <button className={`${btn} bg-cyan-700 hover:bg-cyan-600 text-white`} onClick={() => act(() => send("POST", `/api/tasks/${id}/retry`))}>
                  ↻ {col === "failed" ? "Retry" : "Run again"}
                </button>
              )}
              {(col === "running" || col === "ready" || col === "backlog") && (
                <button className={`${btn} bg-rose-700 hover:bg-rose-600 text-white`} onClick={() => act(() => send("POST", `/api/agent/${id}/cancel`))}>
                  Cancel
                </button>
              )}
              {col !== "running" && (
                <button className={`${btn} bg-slate-800 hover:bg-slate-700 text-slate-400 ml-auto`} onClick={() => act(() => send("POST", `/api/tasks/${id}/archive`), true)}>
                  Remove from board
                </button>
              )}
            </div>
          )}
          {d && (d.files?.length || (d.answer && (col === "done" || col === "review"))) ? (
            <div className="mt-3">
              <FilesBar taskId={id} files={d.files} canMake={Boolean(d.answer) && (col === "done" || col === "review")} />
            </div>
          ) : null}
          {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
        </header>

        {d && editing ? (
          <div className="p-5 overflow-y-auto">
            <CardForm
              initial={{
                title: d.title ?? "",
                prompt: d.prompt,
                targetAgent: d.routedBy === undefined ? "auto" : d.targetAgent,
                priority: d.priority ?? "normal",
                dependsOn: d.dependsOn ?? [],
                needsReview: Boolean(d.needsReview),
                readOnly: Boolean(d.readOnly),
                allowedSites: d.allowedSites ?? [],
                images: d.images ?? [],
                audio: d.audio ?? [],
                documents: d.documents ?? [],
              }}
              cards={cards}
              selfId={id}
              submitLabel="Save changes"
              onCancel={() => setEditing(false)}
              onSubmit={async (f) => {
                await send("PATCH", `/api/tasks/${id}`, f);
                setEditing(false);
                onChanged();
              }}
            />
          </div>
        ) : (
          d && (
            <div className="flex-1 min-h-0 flex flex-col">
              {d.subtasks.length > 0 && (
                <div className="px-5 py-3 border-b border-slate-800 space-y-1.5">
                  <h3 className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Handoffs</h3>
                  {d.subtasks.map((s) => (
                    <div key={s.id} className="text-xs">
                      <button onClick={() => setOpenSub(openSub === s.id ? null : s.id)} className="w-full flex items-center gap-2 text-left hover:bg-slate-800/50 rounded px-1 py-0.5">
                        <span className={`h-2 w-2 rounded-full ${s.status === "complete" ? "bg-emerald-500" : RUNNING.includes(s.status) ? "bg-amber-400 animate-pulse" : "bg-rose-500"}`} />
                        <span className={`px-1.5 rounded ${AGENT_COLORS[s.targetAgent] ?? ""}`}>{AGENT_LABELS[s.targetAgent]}</span>
                        <span className="text-slate-300 truncate flex-1">{s.title}</span>
                        <span className="text-slate-500 font-mono">{splitModel(s.model).name}</span>
                      </button>
                      {openSub === s.id && (
                        <pre className="mt-1 ml-4 p-2 bg-slate-950 rounded text-[11px] text-slate-400 whitespace-pre-wrap max-h-48 overflow-y-auto">
                          {s.answer || s.error || "…"}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-1 px-5 pt-3 text-xs">
                {(["output", "preview"] as const).map((t) => (
                  <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 rounded ${tab === t ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"}`}>
                    {t === "output" ? "Output" : "Preview"}
                  </button>
                ))}
              </div>
              {tab === "output" ? (
                <pre ref={outRef} className="flex-1 min-h-0 overflow-y-auto m-3 p-4 bg-slate-950 rounded-lg text-[13px] leading-relaxed text-slate-300 whitespace-pre-wrap break-words font-mono">
                  {output || (col === "backlog" || col === "ready" ? `> ${d.prompt}\n\n// Not started yet.` : "")}
                </pre>
              ) : (
                <div className="flex-1 min-h-0 flex flex-col m-3 border border-slate-800 rounded-lg overflow-hidden">
                  <PreviewPane output={output} active={RUNNING.includes(d.status)} />
                </div>
              )}
              {(col === "done" || col === "review" || col === "failed") && <ReplyBox taskId={id} agent={d.targetAgent} onSent={onChanged} />}
            </div>
          )
        )}
      </aside>
    </div>
  );
}

/** The card's PDFs, with names looked up from the harness. */
function DocChips({ ids }: { ids: string[] }) {
  const [info, setInfo] = useState<Record<string, DocInfo>>({});
  useEffect(() => {
    for (const id of ids)
      getJson<DocInfo>(`/api/uploads/${id}/info`)
        .then((d) => setInfo((m) => ({ ...m, [id]: d })))
        .catch(() => {});
  }, [ids.join(",")]);
  return (
    <div className="flex flex-wrap gap-2">
      {ids.map((id) => (
        <DocChip key={id} id={id} info={info[id]} />
      ))}
    </div>
  );
}
