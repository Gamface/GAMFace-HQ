import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { send } from "../api";
import { applyAnnotations, blockText, planBlocks } from "../../../src/hq/plans";
import type { AnnotationKind, PlanAnnotation, PlanBlock, PlanState } from "../../../src/hq/plans";

// Plan Markup: select words in the plan (or use a step's own buttons) to comment on
// them, cut them or replace them. "Send back" asks for another version with your
// markup; "Approve & run" makes your cuts and replacements and the card does the work.

type Mark = PlanAnnotation & { key: number };
interface Picked {
  blockId: string;
  quote: string;
  x: number;
  y: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const KIND_LABEL: Record<AnnotationKind, string> = { comment: "Comment", delete: "Cut", replace: "Replace" };

/** One block's text with the marks on it shown in place. */
function MarkedText({ block, marks }: { block: PlanBlock; marks: Mark[] }) {
  const shown = blockText(block);
  const offset = block.raw.length - shown.length; // the heading hashes or list marker
  const spans = marks
    .map((m) => {
      const at = block.raw.indexOf(m.quote);
      const start = Math.max(0, at - offset);
      return { m, start, end: Math.max(start, at + m.quote.length - offset) };
    })
    .filter((s) => s.end > s.start || s.m.quote === block.raw)
    .sort((a, b) => a.start - b.start);
  const out: ReactNode[] = [];
  let pos = 0;
  for (const { m, start, end } of spans) {
    if (start < pos) continue; // overlaps a mark already shown
    out.push(shown.slice(pos, start));
    const text = shown.slice(start, Math.max(end, start)) || shown;
    if (m.kind === "comment") {
      out.push(
        <mark key={m.key} title={m.text} className="bg-cyan-500/20 text-inherit underline decoration-cyan-400 decoration-2 underline-offset-2 rounded-sm">
          {text}
        </mark>,
      );
    } else if (m.kind === "delete") {
      out.push(
        <del key={m.key} className="bg-rose-500/15 text-rose-300/80 decoration-rose-400">
          {text}
        </del>,
      );
    } else {
      out.push(
        <span key={m.key}>
          <del className="bg-amber-500/10 text-amber-300/70 decoration-amber-400">{text}</del>
          <ins className="no-underline bg-emerald-500/20 text-emerald-200 rounded-sm px-0.5">{m.text}</ins>
        </span>,
      );
    }
    pos = Math.max(end, start);
  }
  out.push(shown.slice(pos));
  return <>{out}</>;
}

function BlockView({ block, marks, onWhole }: { block: PlanBlock; marks: Mark[]; onWhole: (kind: AnnotationKind) => void }) {
  const style =
    block.kind === "heading"
      ? block.level === 1
        ? "text-lg font-semibold text-slate-100 mt-3"
        : "text-[15px] font-semibold text-slate-100 mt-3"
      : block.kind === "code"
        ? "font-mono text-xs bg-slate-950 border border-slate-800 rounded-md p-2 whitespace-pre overflow-x-auto"
        : "text-sm text-slate-200 whitespace-pre-wrap";
  const bullet = block.kind === "list" ? (/^\s*\d+[.)]/.test(block.raw) ? block.raw.trim().match(/^\d+[.)]/)![0] : "•") : null;
  return (
    <div className="group relative flex gap-2 rounded-md px-2 py-1 -mx-2 hover:bg-slate-800/40" style={block.level && block.kind === "list" ? { paddingLeft: 8 + block.level * 18 } : undefined}>
      {bullet && <span className="text-slate-500 text-sm tabular-nums shrink-0 select-none">{bullet}</span>}
      <div data-block={block.id} className={`min-w-0 flex-1 ${style}`}>
        <MarkedText block={block} marks={marks} />
      </div>
      {/* Mark the whole step: easier than selecting on a phone */}
      <div className="shrink-0 flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 select-none">
        {(["comment", "delete", "replace"] as const).map((k) => (
          <button
            key={k}
            onClick={() => onWhole(k)}
            title={`${k === "comment" ? "Comment on" : KIND_LABEL[k]} this whole ${block.kind === "heading" ? "heading" : block.kind === "list" ? "step" : "part"}`}
            className="h-6 px-1.5 rounded text-[10px] bg-slate-800 text-slate-400 hover:text-slate-100 hover:bg-slate-700"
          >
            {k === "comment" ? "💬" : k === "delete" ? "✂" : "⇄"}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function PlanReview({ taskId, plan, onDone }: { taskId: string; plan: PlanState; onDone: () => void }) {
  const blocks = useMemo(() => planBlocks(plan.text), [plan.text]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [draft, setDraft] = useState<{ kind: AnnotationKind; text: string } | null>(null);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextKey = useRef(1);
  const boxRef = useRef<HTMLDivElement>(null);

  const add = (m: PlanAnnotation) => {
    setMarks((list) => [...list, { ...m, key: nextKey.current++ }]);
    setPicked(null);
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  };

  // Words selected inside one block become the thing to mark
  const onSelect = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const el = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest("[data-block]");
    const a = el(sel.anchorNode);
    const b = el(sel.focusNode);
    if (!a || a !== b || !boxRef.current?.contains(a)) return;
    const block = blocks.find((x) => x.id === a.getAttribute("data-block"));
    const quote = sel.toString().trim();
    if (!block || !quote || !block.raw.includes(quote)) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    setPicked({ blockId: block.id, quote, x: Math.min(r.left, window.innerWidth - 320), y: r.bottom + 6 });
    setDraft(null);
  };

  const choose = (kind: AnnotationKind, target = picked) => {
    if (!target) return;
    if (kind === "delete") return add({ blockId: target.blockId, quote: target.quote, kind });
    setPicked(target);
    setDraft({ kind, text: kind === "replace" ? target.quote : "" });
  };

  const whole = (block: PlanBlock, kind: AnnotationKind) => {
    const box = boxRef.current?.querySelector(`[data-block="${block.id}"]`)?.getBoundingClientRect();
    choose(kind, { blockId: block.id, quote: block.raw, x: Math.min(box?.left ?? 40, window.innerWidth - 320), y: (box?.bottom ?? 120) + 6 });
  };

  const review = async (decision: "approve" | "revise") => {
    if (decision === "revise" && !marks.length && !note.trim()) {
      setError("Mark something or write a note so the agent knows what to change.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await send("POST", `/api/tasks/${taskId}/plan`, {
        decision,
        version: plan.version,
        note: note.trim() || undefined,
        annotations: marks.map(({ key: _k, ...m }) => m),
      });
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const edited = useMemo(() => applyAnnotations(plan.text, marks), [plan.text, marks]);
  const counts = { comment: 0, delete: 0, replace: 0 } as Record<AnnotationKind, number>;
  for (const m of marks) counts[m.kind]++;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-[11px] text-slate-500">Select words to mark them, or use a step's 💬 ✂ ⇄ buttons.</p>
          <button onClick={() => setPreview((v) => !v)} className="text-[11px] px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 shrink-0">
            {preview ? "Show markup" : "Show result"}
          </button>
        </div>
        {preview ? (
          <pre className="text-sm text-slate-200 whitespace-pre-wrap font-sans bg-slate-950 border border-slate-800 rounded-lg p-4">{edited || "(Nothing left: every part was cut.)"}</pre>
        ) : (
          <div ref={boxRef} onMouseUp={onSelect} onTouchEnd={() => setTimeout(onSelect, 30)} className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-0.5">
            {blocks.map((b) => (
              <BlockView key={b.id} block={b} marks={marks.filter((m) => m.blockId === b.id)} onWhole={(k) => whole(b, k)} />
            ))}
          </div>
        )}
      </div>

      <aside className="space-y-3 min-w-0">
        <div className="text-[11px] text-slate-400">
          {marks.length ? `${counts.comment} comment${counts.comment === 1 ? "" : "s"} · ${counts.delete} cut · ${counts.replace} replaced` : "No markup yet."}
        </div>
        {marks.length > 0 && (
          <ul className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {marks.map((m) => (
              <li key={m.key} className="text-xs bg-slate-950 border border-slate-800 rounded-md p-2">
                <div className="flex items-start gap-2">
                  <span className={`shrink-0 px-1.5 rounded text-[10px] ${m.kind === "comment" ? "bg-cyan-900 text-cyan-200" : m.kind === "delete" ? "bg-rose-900 text-rose-200" : "bg-amber-900 text-amber-200"}`}>
                    {KIND_LABEL[m.kind]}
                  </span>
                  <span className="min-w-0 flex-1 text-slate-400 line-clamp-2">“{blockText({ ...blocks.find((b) => b.id === m.blockId)!, raw: m.quote })}”</span>
                  <button onClick={() => setMarks((l) => l.filter((x) => x.key !== m.key))} aria-label="Remove this mark" className="text-slate-500 hover:text-rose-300">
                    ✕
                  </button>
                </div>
                {m.text && <p className={`mt-1 ${m.kind === "replace" ? "text-emerald-300" : "text-slate-200"}`}>{m.kind === "replace" ? `→ ${m.text}` : m.text}</p>}
              </li>
            ))}
          </ul>
        )}
        <label className="block text-[11px] text-slate-400">
          Note for the whole plan (optional)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-md p-2 text-sm text-slate-100" placeholder="e.g. keep it under a day of work" />
        </label>
        {error && <p className="text-xs text-rose-300">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => void review("approve")} className="px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-50">
            ✓ Approve &amp; run
          </button>
          <button disabled={busy} onClick={() => void review("revise")} className="px-3 py-2 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm disabled:opacity-50">
            ↺ Send back for changes
          </button>
        </div>
        <p className="text-[10px] text-slate-500">Approving makes your cuts and replacements, sends your comments along, and the card runs the plan.</p>
      </aside>

      {/* The toolbar for selected words */}
      {picked && (
        <div className="fixed z-50 w-[300px] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl shadow-black/70 p-2 space-y-2" style={{ left: Math.max(8, picked.x), top: Math.min(picked.y, window.innerHeight - 200) }} onMouseDown={(e) => e.target instanceof HTMLButtonElement && e.preventDefault()}>
          <p className="text-[11px] text-slate-400 line-clamp-2">“{blockText({ ...blocks.find((b) => b.id === picked.blockId)!, raw: picked.quote })}”</p>
          {!draft ? (
            <div className="flex gap-1.5">
              <button onClick={() => choose("comment")} className="flex-1 px-2 py-1.5 rounded bg-cyan-800 hover:bg-cyan-700 text-white text-xs">💬 Comment</button>
              <button onClick={() => choose("delete")} className="flex-1 px-2 py-1.5 rounded bg-rose-800 hover:bg-rose-700 text-white text-xs">✂ Cut</button>
              <button onClick={() => choose("replace")} className="flex-1 px-2 py-1.5 rounded bg-amber-700 hover:bg-amber-600 text-white text-xs">⇄ Replace</button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.kind === "comment" && !draft.text.trim()) return;
                add({ blockId: picked.blockId, quote: picked.quote, kind: draft.kind, text: draft.text });
              }}
              className="space-y-1.5"
            >
              <textarea
                autoFocus
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                rows={3}
                placeholder={draft.kind === "comment" ? "Your comment" : "Replace with…"}
                className="w-full bg-slate-950 border border-slate-700 rounded p-1.5 text-sm text-slate-100"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
                }}
              />
              <div className="flex justify-end gap-1.5">
                <button type="button" onClick={() => setPicked(null)} className="px-2 py-1 rounded bg-slate-800 text-slate-300 text-xs">Cancel</button>
                <button type="submit" className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs">{draft.kind === "comment" ? "Add comment" : "Replace"}</button>
              </div>
            </form>
          )}
          {!draft && (
            <button onClick={() => setPicked(null)} className="w-full text-[10px] text-slate-500 hover:text-slate-300">Cancel</button>
          )}
        </div>
      )}
    </div>
  );
}
