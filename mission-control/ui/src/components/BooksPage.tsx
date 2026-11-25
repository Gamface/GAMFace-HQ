import { useCallback, useEffect, useRef, useState } from "react";
import { fileUrl, getJson, imageUrl, send, uploadImage } from "../api";
import { HARNESS_URL } from "../config";
import { useProjects } from "../project";
import { KIND_LABEL, KdpPanel, ListingPanel, SourcePicker, SourcesPanel, addSource, btn, errText, input, num, pendingName, primary, quiet, trimLabel } from "./BookParts";
import type { Book, Chapter, Kind, PendingSource, Stage } from "./BookParts";
import BookResearch from "./BookResearch";
import type { Concept } from "./BookResearch";

// Books: novels, nonfiction ebooks, children's picture books and puzzle books, written from
// a brief or repurposed from your own content. The Writer plans, waits for you to approve
// the outline, then writes (and illustrates) one step at a time between cards. Download as
// EPUB, Markdown, a print PDF, or KDP paperback files with a listing kit.

interface Summary {
  id: string;
  title: string;
  kind: Kind;
  brief: string;
  stage: Stage;
  paused?: boolean;
  error?: string;
  words: number;
  target: number;
  written: number;
  chapterTotal: number;
  running: string | null;
}

interface ListReply {
  books: Summary[];
  writer: string;
  pdf: boolean;
  pictures: boolean;
  trims: string[];
}

function stageText(b: { stage: Stage; paused?: boolean; running?: unknown; error?: string }): { text: string; tone: string } {
  if (b.running) return { text: "Working now", tone: "bg-cyan-950 text-cyan-300 border-cyan-800" };
  if (b.paused && b.stage !== "done") return { text: b.error ? "Paused (error)" : "Paused", tone: "bg-amber-950 text-amber-300 border-amber-800" };
  return {
    planning: { text: "Planning", tone: "bg-slate-800 text-slate-300 border-slate-700" },
    review: { text: "Outline ready: review it", tone: "bg-amber-950 text-amber-300 border-amber-800" },
    writing: { text: "Writing", tone: "bg-slate-800 text-slate-300 border-slate-700" },
    done: { text: "Finished", tone: "bg-emerald-950 text-emerald-300 border-emerald-800" },
  }[b.stage];
}

const unitOf = (k: Kind) => (k === "picture" ? "page" : k === "puzzle" ? "puzzle" : "chapter");

function Progress({ value, max }: { value: number; max: number }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 rounded bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-cyan-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

// --- New book ------------------------------------------------------------------

const KIND_DEFAULTS: Record<Kind, { count: number; words: number }> = {
  novel: { count: 20, words: 2500 },
  ebook: { count: 10, words: 1500 },
  picture: { count: 14, words: 40 },
  puzzle: { count: 20, words: 250 },
};

const PLACEHOLDER: Record<Kind, string> = {
  novel: "A lighthouse keeper on a remote Scottish island finds a message in a bottle written by her future self, warning her about the night of the great storm…",
  ebook: "A practical guide for complete beginners to bake their first sourdough loaf at home, from starter to slicing, with a weekly schedule…",
  picture: "A shy hedgehog called Pip is scared of the dark, until the fireflies in the garden show him the night is full of friends. For ages 3–6, about bravery.",
  puzzle: "Cosy murder mysteries in a 1920s seaside hotel, solved by a retired cook with a sharp eye for detail.",
};

function NewBook({ onMade, onCancel, pictures, initial }: { onMade: (id: string) => void; onCancel: () => void; pictures: boolean; initial?: Concept | null }) {
  const proj = useProjects();
  // From niche research: the idea's kind, title, audience and brief
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "novel");
  const [f, setF] = useState({
    brief: initial ? `${initial.brief}${initial.angle ? `\n\nAngle: ${initial.angle}` : ""}` : "",
    title: initial?.title ?? "",
    author: "",
    genre: initial?.keyword ?? "",
    audience: initial?.audience ?? "",
    style: "",
    chapterCount: KIND_DEFAULTS[initial?.kind ?? "novel"].count,
    chapterWords: KIND_DEFAULTS[initial?.kind ?? "novel"].words,
    artStyle: "",
    puzzleType: "mystery",
    difficulty: "medium",
  });
  const [pending, setPending] = useState<PendingSource[]>([]);
  const [faithful, setFaithful] = useState(true);
  const [usePictures, setUsePictures] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const pick = (k: Kind) => {
    setKind(k);
    setF((x) => ({ ...x, chapterCount: KIND_DEFAULTS[k].count, chapterWords: KIND_DEFAULTS[k].words }));
  };
  const create = async () => {
    setBusy("Creating…");
    setError(null);
    try {
      // With sources, the book waits (paused) until they're all in
      const b = await send<Book>("POST", "/api/books", { ...f, kind, project: proj.target, start: pending.length === 0, faithful, pictures: usePictures });
      const failed: string[] = [];
      for (const s of pending) {
        setBusy(`Adding ${pendingName(s)}…`);
        try {
          await addSource(b.id, s);
        } catch (e) {
          failed.push(`${pendingName(s)}: ${errText(e)}`);
        }
      }
      if (pending.length && !failed.length) await send("PATCH", `/api/books/${b.id}`, { paused: false });
      if (failed.length) alert(`Some sources couldn't be added, so the book is paused. Fix them on its page, then press Resume.\n\n${failed.join("\n")}`);
      onMade(b.id);
    } catch (e) {
      setError(errText(e));
      setBusy(null);
    }
  };
  const fiction = kind === "novel" || kind === "picture";
  const unit = unitOf(kind);
  return (
    <div className="max-w-2xl space-y-3">
      <h2 className="text-lg font-semibold text-slate-100">New book</h2>
      {initial && <p className="text-xs text-cyan-300">From your niche research: “{initial.title}”. Adjust anything, then start planning.</p>}
      <div className="flex flex-wrap gap-2">
        {(["novel", "ebook", "picture", "puzzle"] as const).map((k) => (
          <button key={k} onClick={() => pick(k)} className={`${btn} border ${kind === k ? "border-cyan-600 bg-cyan-950 text-cyan-300" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
            {{ novel: "Novel / fiction", ebook: "Ebook / nonfiction", picture: "Children's picture book", puzzle: "Puzzle / mystery book" }[k]}
          </button>
        ))}
      </div>
      <label className="block text-xs text-slate-400">
        {kind === "ebook" ? "What it teaches (or what to make from your content)" : kind === "puzzle" ? "The theme" : "The story"}
        <textarea value={f.brief} onChange={(e) => set("brief", e.target.value)} rows={4} maxLength={6000} className={`${input} mt-1`} placeholder={PLACEHOLDER[kind]} />
      </label>

      {kind === "puzzle" && (
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-slate-400">
            Puzzles
            <select value={f.puzzleType} onChange={(e) => set("puzzleType", e.target.value)} className={`${input} mt-1`}>
              <option value="mystery">Whodunit cases (suspect, place, weapon)</option>
              <option value="logic">Logic grid puzzles</option>
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Difficulty
            <select value={f.difficulty} onChange={(e) => set("difficulty", e.target.value)} className={`${input} mt-1`}>
              <option value="easy">Easy (4 people, 3 categories)</option>
              <option value="medium">Medium (4 people, 4 categories)</option>
              <option value="hard">Hard (5 people, 4 categories)</option>
            </select>
          </label>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-xs text-slate-400">
          Title (optional: the Writer suggests one)
          <input value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={200} className={`${input} mt-1`} />
        </label>
        <label className="text-xs text-slate-400">
          Author name
          <input value={f.author} onChange={(e) => set("author", e.target.value)} maxLength={120} className={`${input} mt-1`} placeholder="Anonymous" />
        </label>
        {kind !== "picture" && kind !== "puzzle" && (
          <label className="text-xs text-slate-400">
            {fiction ? "Genre" : "Topic area"}
            <input value={f.genre} onChange={(e) => set("genre", e.target.value)} maxLength={120} className={`${input} mt-1`} placeholder={fiction ? "Cozy mystery, literary thriller…" : "Baking, personal finance…"} />
          </label>
        )}
        <label className="text-xs text-slate-400">
          Audience
          <input
            value={f.audience}
            onChange={(e) => set("audience", e.target.value)}
            maxLength={300}
            className={`${input} mt-1`}
            placeholder={kind === "picture" ? "Ages 3–6, read aloud at bedtime" : kind === "puzzle" ? "Adults who like cosy mysteries" : fiction ? "Adult readers, young adult…" : "Complete beginners, busy parents…"}
          />
        </label>
      </div>
      {kind === "picture" ? (
        <label className="block text-xs text-slate-400">
          Art style (optional)
          <input value={f.artStyle} onChange={(e) => set("artStyle", e.target.value)} maxLength={300} className={`${input} mt-1`} placeholder="Soft watercolour, warm pastel colours, gentle rounded shapes" />
        </label>
      ) : (
        <label className="block text-xs text-slate-400">
          Style and voice
          <input
            value={f.style}
            onChange={(e) => set("style", e.target.value)}
            maxLength={1000}
            className={`${input} mt-1`}
            placeholder={kind === "novel" ? "First person, present tense, wry and atmospheric, short chapters that end on hooks" : kind === "puzzle" ? "Witty, a little gothic, each story about one page" : "Friendly and encouraging, plain English, a checklist at the end of each chapter"}
          />
        </label>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-400">
          {unit === "page" ? "Pages" : unit === "puzzle" ? "Puzzles" : "Chapters"}
          <input type="number" min={1} max={60} value={f.chapterCount} onChange={(e) => set("chapterCount", Number(e.target.value))} className={`${input} mt-1 w-24`} />
        </label>
        <label className="text-xs text-slate-400">
          Words per {unit === "puzzle" ? "story" : unit}
          <input type="number" min={5} max={8000} step={kind === "picture" ? 5 : 50} value={f.chapterWords} onChange={(e) => set("chapterWords", Number(e.target.value))} className={`${input} mt-1 w-32`} />
        </label>
        <p className="text-xs text-slate-500 pb-2">≈ {num(f.chapterCount * f.chapterWords)} words</p>
      </div>
      {kind === "picture" && (
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={usePictures} onChange={(e) => setUsePictures(e.target.checked)} />
          Illustrate every page with the picture tool (ComfyUI on this PC){!pictures && <span className="text-amber-300"> — the tools service isn't set up, so turn this off or set TOOLS_URL</span>}
        </label>
      )}

      {kind !== "puzzle" && (
        <details className="rounded border border-slate-800 p-3" open={pending.length > 0}>
          <summary className="text-sm text-slate-200 cursor-pointer">Start from my own content (optional)</summary>
          <p className="text-[11px] text-slate-500 mt-1 mb-2">Blog posts, a Google Doc, YouTube videos, PDFs, Word files, recordings or notes. The Writer plans the book around them and writes each chapter from the matching passages.</p>
          <SourcePicker onAdd={(l) => setPending((p) => [...p, ...l])} />
          {pending.length > 0 && (
            <>
              <ul className="mt-2 space-y-1 text-xs">
                {pending.map((s, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="text-[10px] uppercase text-slate-500 w-10">{s.kind}</span>
                    <span className="flex-1 truncate text-slate-300">{pendingName(s)}</span>
                    <button onClick={() => setPending((p) => p.filter((_, j) => j !== i))} className="text-slate-500 hover:text-rose-300" aria-label="Remove">
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <label className="flex items-center gap-2 text-xs text-slate-300 mt-2">
                <input type="checkbox" checked={faithful} onChange={(e) => setFaithful(e.target.checked)} />
                Stay true to my content (repurpose it; don't add facts that aren't in it)
              </label>
            </>
          )}
        </details>
      )}

      <p className="text-xs text-slate-500">
        {kind === "puzzle"
          ? "Puzzles are built and checked in code, so each has exactly one answer. The Writer writes the stories and never sees the answers."
          : "The Writer plans first and nothing is written until you've checked and approved the outline."}
      </p>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex items-center gap-2">
        <button disabled={Boolean(busy) || f.brief.trim().length < 10} onClick={() => void create()} className={primary}>
          {busy ?? "Start planning"}
        </button>
        <button onClick={onCancel} className={quiet}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// --- Outline editor (review stage) -----------------------------------------------

interface Draft {
  from?: number;
  title: string;
  beats: string;
  text?: string;
}

function OutlineEditor({ book, onSaved }: { book: Book; onSaved: (b: Book) => void }) {
  const picture = book.kind === "picture";
  const [rows, setRows] = useState<Draft[]>(() => book.chapters.map((c, i) => ({ from: i, title: c.title, beats: c.beats, ...(picture ? { text: c.text ?? "" } : {}) })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = (i: number, k: "title" | "beats" | "text", v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const move = (i: number, d: -1 | 1) =>
    setRows((r) => {
      const n = [...r];
      const j = i + d;
      if (j < 0 || j >= n.length) return r;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  const save = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let b = await send<Book>("PATCH", `/api/books/${book.id}`, { chapters: rows });
      if (approve) b = await send<Book>("POST", `/api/books/${book.id}/approve`);
      onSaved(b);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const unit = unitOf(book.kind);
  return (
    <div className="space-y-2">
      {rows.map((r, i) => {
        const pv = r.from !== undefined ? book.chapters[r.from]?.puzzleView : undefined;
        return (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/50 p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 w-6 text-right">{i + 1}</span>
              <input value={r.title} onChange={(e) => edit(i, "title", e.target.value)} maxLength={200} className={`${input} flex-1`} aria-label={`${unit} ${i + 1} title`} />
              <button onClick={() => move(i, -1)} disabled={i === 0} className="text-slate-500 hover:text-slate-200 disabled:opacity-30 px-1" aria-label="Move up">
                ↑
              </button>
              <button onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="text-slate-500 hover:text-slate-200 disabled:opacity-30 px-1" aria-label="Move down">
                ↓
              </button>
              <button onClick={() => setRows((x) => x.filter((_, j) => j !== i))} disabled={rows.length === 1} className="text-slate-500 hover:text-rose-300 disabled:opacity-30 px-1" aria-label={`Remove ${unit}`}>
                ✕
              </button>
            </div>
            {picture && (
              <textarea value={r.text ?? ""} onChange={(e) => edit(i, "text", e.target.value)} rows={2} maxLength={1500} className={`${input} text-sm font-serif`} aria-label={`Page ${i + 1} text`} placeholder="The words on the page" />
            )}
            <textarea
              value={r.beats}
              onChange={(e) => edit(i, "beats", e.target.value)}
              rows={2}
              maxLength={3000}
              className={`${input} text-xs`}
              aria-label={picture ? `Page ${i + 1} picture` : `Chapter ${i + 1} beats`}
              placeholder={picture ? "What the picture shows" : book.kind === "puzzle" ? "The scene" : "What happens"}
            />
            {pv && (
              <p className="text-[11px] text-slate-500">
                {pv.categories.join(" · ")} · {pv.clues.length} clues, one answer
              </p>
            )}
          </div>
        );
      })}
      <button onClick={() => setRows((x) => [...x, { title: picture ? `Page ${x.length + 1}` : `${unit[0].toUpperCase()}${unit.slice(1)} ${x.length + 1}`, beats: "", ...(picture ? { text: "" } : {}) }])} disabled={rows.length >= 60} className={quiet}>
        + Add {unit}
      </button>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        <button disabled={busy} onClick={() => void save(true)} className={primary}>
          Approve and start {book.kind === "picture" ? (book.art?.off ? "finishing" : "illustrating") : "writing"}
        </button>
        <button disabled={busy} onClick={() => void save(false)} className={quiet}>
          Save changes
        </button>
      </div>
    </div>
  );
}

// --- One chapter, page or puzzle (writing and done) --------------------------------

function ChapterRow({ book, ch, i, busy, onChange }: { book: Book; ch: Chapter; i: number; busy: boolean; onChange: (b: Book) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(ch.text ?? "");
  const [note, setNote] = useState("");
  const [showAnswer, setShowAnswer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picture = book.kind === "picture";
  const pv = ch.puzzleView;
  const done = picture ? Boolean(ch.text && (ch.image || book.art?.off)) : book.kind === "puzzle" ? Boolean(ch.text && pv) : Boolean(ch.text && ch.summary);
  const status = done ? "done" : ch.text ? "drafting" : "planned";
  const act = async (fn: () => Promise<Book>) => {
    setError(null);
    try {
      onChange(await fn());
      setEditing(false);
      setNote("");
    } catch (e) {
      setError(errText(e));
    }
  };
  const rewrite = (part: "text" | "picture" | "puzzle") => act(() => send<Book>("POST", `/api/books/${book.id}/chapters/${i}/rewrite`, { note, part }));
  return (
    <div className="border-b border-slate-800 last:border-0">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-3 py-2 text-left hover:bg-slate-900/60 px-1" aria-expanded={open}>
        <span className="text-xs text-slate-500 w-6 text-right">{i + 1}</span>
        {picture && ch.image && <img src={fileUrl(ch.image)} alt="" className="h-8 w-8 rounded object-cover" />}
        <span className="flex-1 text-sm text-slate-200 truncate">{picture ? ch.text || ch.title : ch.title}</span>
        <span className={`text-[11px] ${status === "done" ? "text-emerald-400" : status === "drafting" ? "text-cyan-400" : "text-slate-500"}`}>
          {picture ? (ch.image ? "illustrated" : ch.text ? (book.art?.off ? "text" : "needs picture") : "planned") : status === "planned" ? "planned" : `${num(ch.words ?? 0)} words`}
        </span>
      </button>
      {open && (
        <div className="pl-9 pr-1 pb-3 space-y-2">
          {picture && ch.image && <img src={fileUrl(ch.image)} alt={ch.beats} className="max-h-80 rounded border border-slate-800" />}
          <p className="text-xs text-slate-400">
            <span className="text-slate-500">{picture ? "Picture" : book.kind === "novel" ? "Beats" : book.kind === "puzzle" ? "Scene" : "Covers"}:</span> {ch.beats || "—"}
          </p>
          {ch.note && <p className="text-xs text-amber-300">Your note: {ch.note}</p>}
          {editing ? (
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={picture ? 3 : 18} className={`${input} font-serif leading-relaxed`} />
          ) : ch.text ? (
            <div className={`rounded bg-slate-950 border border-slate-800 p-3 text-slate-300 font-serif leading-relaxed whitespace-pre-wrap ${picture ? "text-base" : "text-sm max-h-96 overflow-y-auto"}`}>{ch.text}</div>
          ) : null}
          {pv && (
            <div className="rounded border border-slate-800 p-3 text-xs space-y-2">
              {pv.crime && <p className="text-slate-300">{pv.crime}</p>}
              <p className="text-slate-500">{pv.categories.join(" · ")}</p>
              <ol className="list-decimal pl-5 space-y-0.5 text-slate-300">
                {pv.clues.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
              <button onClick={() => setShowAnswer((s) => !s)} className="text-cyan-400 hover:text-cyan-300">
                {showAnswer ? "Hide the answer" : "Show the answer"}
              </button>
              {showAnswer && (
                <div className="text-slate-300">
                  {pv.answer && <p className="font-medium">{pv.answer}</p>}
                  <table className="mt-1 border-collapse">
                    <tbody>
                      {pv.rows.map((r) => (
                        <tr key={r[0]}>
                          {r.map((x, j) => (
                            <td key={j} className="border border-slate-700 px-2 py-0.5">
                              {x}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {ch.summary && !editing && (
            <p className="text-[11px] text-slate-500">
              <span className="text-slate-400">Continuity note:</span> {ch.summary}
            </p>
          )}
          {ch.model && <p className="text-[11px] text-slate-600">Written by {ch.model}</p>}
          {error && <p className="text-xs text-rose-300">{error}</p>}
          {(ch.text || ch.image) && (
            <div className="flex flex-wrap items-center gap-2">
              {editing ? (
                <>
                  <button disabled={busy} onClick={() => void act(() => send<Book>("PATCH", `/api/books/${book.id}`, { chapters: book.chapters.map((_, j) => (j === i ? { from: j, text } : { from: j })) }))} className={primary}>
                    Save text
                  </button>
                  <button onClick={() => setEditing(false)} className={quiet}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setText(ch.text ?? "");
                      setEditing(true);
                    }}
                    className={quiet}
                  >
                    Edit text
                  </button>
                  {picture && !book.art?.off && (
                    <button disabled={busy} onClick={() => void rewrite("picture")} className={quiet}>
                      Draw again
                    </button>
                  )}
                  {book.kind === "puzzle" && (
                    <button disabled={busy} onClick={() => void rewrite("puzzle")} className={quiet} title="Same people and places, new clues and answer">
                      New puzzle
                    </button>
                  )}
                  <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Note for a rewrite (optional): more dialogue, slower pace…" className={`${input} text-xs flex-1 min-w-48`} />
                  <button disabled={busy} onClick={() => void rewrite("text")} className={quiet}>
                    Rewrite {picture ? "text" : book.kind === "puzzle" ? "story" : ""}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Picture book art settings -------------------------------------------------------

function ArtPanel({ book, onChange, busy }: { book: Book; onChange: (b: Book) => void; busy: boolean }) {
  const [style, setStyle] = useState(book.art?.style ?? "");
  const [characters, setCharacters] = useState(book.art?.characters ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Record<string, unknown>) => {
    setError(null);
    try {
      onChange(await send<Book>("PATCH", `/api/books/${book.id}`, { art: patch }));
    } catch (e) {
      setError(errText(e));
    }
  };
  if (!book.art) return null;
  return (
    <section className="rounded border border-slate-800 p-3 space-y-2">
      <h3 className="text-sm font-medium text-slate-200">Pictures</h3>
      <p className="text-[11px] text-slate-500">Every picture uses this style and these character descriptions word for word, with the same seed ({book.art.seed}), so the characters stay recognisable from page to page.</p>
      <label className="block text-xs text-slate-400">
        Art style
        <input value={style} onChange={(e) => setStyle(e.target.value)} maxLength={300} className={`${input} mt-1 text-xs`} />
      </label>
      <label className="block text-xs text-slate-400">
        Characters
        <textarea value={characters} onChange={(e) => setCharacters(e.target.value)} rows={3} maxLength={2000} className={`${input} mt-1 text-xs`} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={busy} onClick={() => void save({ style, characters })} className={quiet}>
          Save
        </button>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={!book.art.off} disabled={busy} onChange={(e) => void save({ off: !e.target.checked })} />
          Make pictures with the picture tool
        </label>
      </div>
      <p className="text-[11px] text-slate-500">Changing the style or characters affects pictures made from now on; use “Draw again” on a page to redo one.</p>
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </section>
  );
}

// --- One book --------------------------------------------------------------------

function BookView({ id, meta, onGone, onChanged }: { id: string; meta: ListReply | null; onGone: () => void; onChanged: () => void }) {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bibleOpen, setBibleOpen] = useState(false);
  const [bible, setBible] = useState("");
  const [trim, setTrim] = useState("");
  const [pdf, setPdf] = useState<{ busy: boolean; url?: string; error?: string }>({ busy: false });
  const live = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    getJson<Book>(`/api/books/${id}`)
      .then((b) => {
        setBook(b);
        setError(null);
      })
      .catch((e) => setError(errText(e)));
  }, [id]);
  useEffect(() => {
    setBook(null);
    setPdf({ busy: false });
    load();
  }, [load]);
  // Poll while the Writer is working on it, more slowly otherwise
  const active = Boolean(book?.running) || Boolean(book?.wantListing) || ((book?.stage === "planning" || book?.stage === "writing") && !book?.paused);
  useEffect(() => {
    const t = setInterval(load, book?.running ? 1500 : active ? 5000 : 20000);
    return () => clearInterval(t);
  }, [load, active, book?.running]);
  useEffect(() => {
    if (live.current) live.current.scrollTop = live.current.scrollHeight;
  }, [book?.running?.text]);

  const update = (b: Book) => {
    setBook(b);
    onChanged();
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      const out = await fn();
      if (out && typeof out === "object" && "id" in out) update(out as Book);
      else load();
    } catch (e) {
      setError(errText(e));
    }
  };

  if (!book) return <p className="text-sm text-slate-500">{error ?? "Loading…"}</p>;
  const st = stageText(book);
  const words = book.chapters.reduce((n, c) => n + (c.words ?? 0), 0);
  const hasText = book.chapters.some((c) => c.text || c.image);
  const busy = Boolean(book.running);
  const exportUrl = (fmt: string) => `${HARNESS_URL}/api/books/${book.id}/export/${fmt}`;
  const unit = unitOf(book.kind);
  const pdfTrim = trim || book.trim || (book.kind === "picture" ? "8.5x8.5" : book.kind === "puzzle" ? "8.5x11" : "6x9");

  const setCover = async (file: File | undefined) => {
    if (!file) return;
    await act(async () => send<Book>("PATCH", `/api/books/${book.id}`, { cover: await uploadImage(file) }));
  };
  const makePdf = async () => {
    setPdf({ busy: true });
    try {
      const out = await send<{ name: string }>("POST", `/api/books/${book.id}/pdf`, { trim: pdfTrim });
      setPdf({ busy: false, url: fileUrl(out.name, true) });
    } catch (e) {
      setPdf({ busy: false, error: errText(e) });
    }
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex gap-4">
        {book.cover ? (
          <img src={imageUrl(book.cover)} alt="Cover" className="w-20 h-28 object-cover rounded border border-slate-700 shrink-0" />
        ) : (
          <div className="w-20 h-28 rounded border border-dashed border-slate-700 shrink-0 flex items-center justify-center text-[10px] text-slate-600 text-center p-1">No cover</div>
        )}
        <div className="flex-1 min-w-0 space-y-1">
          <h2 className="text-xl font-semibold text-slate-100 truncate">{book.title || "Untitled"}</h2>
          {book.subtitle && <p className="text-sm text-slate-400 italic">{book.subtitle}</p>}
          <p className="text-xs text-slate-500">
            {KIND_LABEL[book.kind]}
            {book.puzzle ? ` (${book.puzzle.type === "logic" ? "logic grids" : "whodunits"}, ${book.puzzle.difficulty})` : ""} · by {book.author} ·{" "}
            {book.kind === "picture" ? `${book.chapters.filter((c) => c.image).length} of ${book.chapterCount} pages illustrated` : `${num(words)} of ~${num(book.chapterCount * book.chapterWords)} words`}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className={`text-[11px] px-2 py-0.5 rounded border ${st.tone}`}>{st.text}</span>
            {book.next && !book.running && !book.paused && <span className="text-[11px] text-slate-500">Next: {book.next} (runs when no card is waiting)</span>}
          </div>
          <label className="inline-block text-[11px] text-cyan-400 hover:text-cyan-300 cursor-pointer pt-1">
            {book.cover ? "Change cover picture" : "Add a cover picture"}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void setCover(e.target.files?.[0])} />
          </label>
          {book.cover && (
            <button onClick={() => void act(() => send<Book>("PATCH", `/api/books/${book.id}`, { cover: null }))} className="text-[11px] text-slate-500 hover:text-rose-300 ml-3">
              Remove cover
            </button>
          )}
        </div>
      </div>

      {book.error && <p className="text-xs text-rose-300 rounded border border-rose-900 bg-rose-950/40 px-3 py-2">{book.error}</p>}
      {error && <p className="text-xs text-rose-300">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {book.paused && book.stage !== "done" ? (
          <button onClick={() => void act(() => send<Book>("PATCH", `/api/books/${book.id}`, { paused: false }))} className={primary}>
            Resume
          </button>
        ) : (
          book.stage !== "done" &&
          book.stage !== "review" && (
            <button onClick={() => void act(() => send<Book>("PATCH", `/api/books/${book.id}`, { paused: true }))} className={quiet}>
              {busy ? "Stop and pause" : "Pause"}
            </button>
          )
        )}
        {!busy && !book.chapters.some((c) => c.text && book.kind !== "picture") && book.bible && (
          <>
            <button onClick={() => void act(() => send<Book>("POST", `/api/books/${book.id}/replan`, { what: "outline", force: book.kind === "picture" }))} className={quiet}>
              New outline
            </button>
            <button onClick={() => void act(() => send<Book>("POST", `/api/books/${book.id}/replan`, { what: "bible", force: book.kind === "picture" }))} className={quiet}>
              Plan again from scratch
            </button>
          </>
        )}
        <span className="flex-1" />
        <button
          onClick={() => {
            if (confirm(`Delete “${book.title || "Untitled"}” and everything written for it? This can't be undone.`)) void act(() => send("DELETE", `/api/books/${book.id}`)).then(onGone);
          }}
          className={`${btn} text-slate-500 hover:text-rose-300`}
        >
          Delete
        </button>
      </div>

      {book.running && (
        <section className="rounded border border-cyan-900 bg-slate-950">
          <p className="px-3 py-2 text-xs text-cyan-300 border-b border-cyan-950">
            {book.running.label}… <span className="text-slate-500">({book.running.label.startsWith("Illustrating") ? "picture tool" : (meta?.writer ?? "Writer")})</span>
          </p>
          <div ref={live} className="max-h-64 overflow-y-auto px-3 py-2 text-sm text-slate-300 font-serif leading-relaxed whitespace-pre-wrap">
            {book.running.text || (book.running.label.startsWith("Illustrating") ? "Drawing (about a minute and a half on your graphics card)…" : "Waiting for the first words…")}
          </div>
        </section>
      )}

      {hasText && (
        <section className="rounded border border-slate-800 p-3 space-y-2">
          <h3 className="text-sm font-medium text-slate-200">Download</h3>
          <div className="flex flex-wrap items-center gap-2">
            <a href={exportUrl("epub")} className={primary}>
              EPUB (ebook readers, Kindle, Apple Books)
            </a>
            <a href={exportUrl("md")} className={quiet}>
              Markdown
            </a>
            <span className="w-px h-5 bg-slate-800 mx-1" />
            <select value={pdfTrim} onChange={(e) => setTrim(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" aria-label="Page size">
              {(meta?.trims ?? ["6x9"]).map((t) => (
                <option key={t} value={t}>
                  {trimLabel(t)}
                </option>
              ))}
            </select>
            <button disabled={pdf.busy || meta?.pdf === false} onClick={() => void makePdf()} className={quiet} title={meta?.pdf === false ? "PDFs need the browser sidecar (BROWSER_CDP_URL)" : undefined}>
              {pdf.busy ? "Printing…" : "PDF"}
            </button>
            {pdf.url && (
              <a href={pdf.url} className="text-xs text-cyan-400 hover:text-cyan-300">
                Download PDF
              </a>
            )}
          </div>
          {pdf.error && <p className="text-xs text-rose-300">{pdf.error}</p>}
          {book.stage !== "done" && <p className="text-[11px] text-slate-500">Downloads include what's done so far.</p>}
        </section>
      )}

      {hasText && <KdpPanel book={book} trims={meta?.trims ?? ["6x9"]} available={meta?.pdf !== false} />}
      {book.bible && <ListingPanel book={book} onChange={update} />}
      {book.kind !== "puzzle" && <SourcesPanel book={book} onChange={update} busy={busy} />}
      {book.kind === "picture" && book.bible && <ArtPanel key={`${book.art?.style}|${book.art?.characters}`} book={book} onChange={update} busy={busy} />}

      <section className="space-y-2">
        <button onClick={() => (setBible(book.bible), setBibleOpen((o) => !o))} className="text-sm font-medium text-slate-200 hover:text-cyan-300" aria-expanded={bibleOpen}>
          {bibleOpen ? "▾" : "▸"} {book.kind === "novel" ? "Story bible" : book.kind === "picture" ? "Story and characters" : "Book plan"} {book.bible ? "" : "(not written yet)"}
        </button>
        {bibleOpen && (
          <div className="space-y-2">
            <p className="text-[11px] text-slate-500">Everything is written with this in view. Fix names, the ending or the style here and what's written next follows it.</p>
            <textarea value={bible} onChange={(e) => setBible(e.target.value)} rows={16} className={`${input} text-xs font-mono`} />
            <button disabled={busy} onClick={() => void act(() => send<Book>("PATCH", `/api/books/${book.id}`, { bible }))} className={quiet}>
              Save
            </button>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-slate-200">
          {book.stage === "review" ? `Outline: edit it, then approve` : `${unit[0].toUpperCase()}${unit.slice(1)}s`} {book.chapters.length ? `(${book.chapters.length})` : ""}
        </h3>
        {!book.chapters.length ? (
          <p className="text-xs text-slate-500">{book.stage === "planning" ? "The outline comes after the plan." : "Nothing here."}</p>
        ) : book.stage === "review" ? (
          <OutlineEditor key={book.updatedAt} book={book} onSaved={update} />
        ) : (
          <div className="rounded border border-slate-800 px-2">
            {book.chapters.map((c, i) => (
              <ChapterRow key={`${i}-${c.title}-${c.words ?? 0}-${c.image ?? ""}`} book={book} ch={c} i={i} busy={busy} onChange={update} />
            ))}
          </div>
        )}
      </section>

      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer hover:text-slate-300">The brief</summary>
        <p className="mt-2 whitespace-pre-wrap text-slate-400">{book.brief}</p>
        <p className="mt-1">
          {[book.genre, book.audience, book.style].filter(Boolean).join(" · ")} · {book.chapterWords} words per {unit === "puzzle" ? "story" : unit}
        </p>
      </details>
    </div>
  );
}

// --- The page ----------------------------------------------------------------------

export default function BooksPage() {
  const proj = useProjects();
  const [list, setList] = useState<ListReply | null>(null);
  const [selected, setSelected] = useState<string | "new" | "research" | null>(null);
  const [prefill, setPrefill] = useState<Concept | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<ListReply>(`/api/books${proj.query ? `?${proj.query}` : ""}`)
      .then((r) => {
        setList(r);
        setError(null);
      })
      .catch((e) => setError(errText(e)));
  }, [proj.query]);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);
  // Open the first book (or the form when there are none) once the list arrives
  useEffect(() => {
    if (list && selected === null) setSelected(list.books[0]?.id ?? "new");
  }, [list, selected]);

  return (
    <div className="col-span-3 min-h-0 flex flex-col md:flex-row gap-4">
      <aside className="md:w-72 shrink-0 bg-slate-900 border border-slate-800 rounded-xl overflow-y-auto max-h-72 md:max-h-none">
        <div className="p-3 flex items-center justify-between">
          <h1 className="text-sm font-semibold text-slate-100">Books</h1>
          <div className="flex gap-1.5">
            <button onClick={() => setSelected("research")} className={`${quiet} ${selected === "research" ? "border-cyan-700 text-cyan-300" : ""}`} title="Research what buyers search for on Amazon">
              Find a niche
            </button>
            <button
              onClick={() => {
                setPrefill(null);
                setSelected("new");
              }}
              className={primary}
            >
              + New book
            </button>
          </div>
        </div>
        {list && <p className="px-3 pb-2 text-[11px] text-slate-500">Writer: {list.writer} (change it on the Team page)</p>}
        {error && <p className="px-3 text-xs text-rose-300">{error}</p>}
        {list?.books.map((b) => {
          const st = stageText(b);
          return (
            <button
              key={b.id}
              onClick={() => setSelected(b.id)}
              className={`w-full text-left px-3 py-2.5 border-t border-slate-800/70 space-y-1.5 ${selected === b.id ? "bg-cyan-950/40" : "hover:bg-slate-900"}`}
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm text-slate-200 truncate">{b.title || b.brief.slice(0, 50)}</span>
                <span className="text-[10px] text-slate-500 uppercase">{KIND_LABEL[b.kind]}</span>
              </div>
              <Progress value={b.kind === "picture" || b.kind === "puzzle" ? b.written : b.words} max={b.kind === "picture" || b.kind === "puzzle" ? b.chapterTotal : b.target} />
              <div className="flex justify-between text-[11px]">
                <span className={st.tone.split(" ").find((c) => c.startsWith("text-"))}>{b.running ?? st.text}</span>
                <span className="text-slate-500">
                  {b.written}/{b.chapterTotal || "?"} {b.kind === "picture" ? "pp" : b.kind === "puzzle" ? "pz" : "ch"}
                  {b.kind === "novel" || b.kind === "ebook" ? ` · ${num(b.words)} w` : ""}
                </span>
              </div>
            </button>
          );
        })}
        {list && !list.books.length && <p className="px-3 py-2 text-xs text-slate-500">No books yet.</p>}
      </aside>
      <main className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded-xl overflow-y-auto p-4 md:p-6">
        {selected === "research" ? (
          <BookResearch
            onStart={(c) => {
              setPrefill(c);
              setSelected("new");
            }}
          />
        ) : selected === "new" ? (
          <NewBook
            key={prefill?.title ?? "blank"}
            initial={prefill}
            pictures={list?.pictures !== false}
            onMade={(id) => {
              setSelected(id);
              load();
            }}
            onCancel={() => setSelected(list?.books[0]?.id ?? null)}
          />
        ) : selected ? (
          <BookView
            key={selected}
            id={selected}
            meta={list}
            onGone={() => {
              setSelected(null);
              load();
            }}
            onChanged={load}
          />
        ) : null}
      </main>
    </div>
  );
}
