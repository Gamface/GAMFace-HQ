import { useCallback, useEffect, useRef, useState } from "react";
import { fileUrl, getJson, imageUrl, send, uploadImage } from "../api";
import { HARNESS_URL } from "../config";
import { useProjects } from "../project";

// Books: novels and nonfiction ebooks. You give a brief; the Writer plans a story bible
// and an outline, waits for you to edit and approve it, then writes the chapters one at
// a time between cards. Download as EPUB, Markdown or a print-ready PDF.

type Kind = "novel" | "ebook";
type Stage = "planning" | "review" | "writing" | "done";

interface Chapter {
  title: string;
  beats: string;
  text?: string;
  summary?: string;
  words?: number;
  note?: string;
  model?: string;
}

interface Summary {
  id: string;
  title: string;
  subtitle?: string;
  author: string;
  kind: Kind;
  brief: string;
  stage: Stage;
  paused?: boolean;
  error?: string;
  project: string | null;
  words: number;
  target: number;
  written: number;
  chapterTotal: number;
  next: string | null;
  running: string | null;
  updatedAt: number;
}

interface Book extends Omit<Summary, "words" | "target" | "written" | "chapterTotal" | "running"> {
  genre: string;
  audience: string;
  style: string;
  chapterCount: number;
  chapterWords: number;
  bible: string;
  chapters: Chapter[];
  cover?: string;
  running: { label: string; text: string; startedAt: number } | null;
}

interface ListReply {
  books: Summary[];
  writer: string;
  pdf: boolean;
  trims: string[];
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");
const input = "w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";
const btn = "px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50";
const primary = `${btn} bg-cyan-600 hover:bg-cyan-500 text-white`;
const quiet = `${btn} border border-slate-700 text-slate-300 hover:bg-slate-800`;
const num = (n: number) => n.toLocaleString();

function stageText(b: { stage: Stage; paused?: boolean; running?: unknown; error?: string }): { text: string; tone: string } {
  if (b.running) return { text: "Writing now", tone: "bg-cyan-950 text-cyan-300 border-cyan-800" };
  if (b.paused && b.stage !== "done") return { text: b.error ? "Paused (error)" : "Paused", tone: "bg-amber-950 text-amber-300 border-amber-800" };
  return {
    planning: { text: "Planning", tone: "bg-slate-800 text-slate-300 border-slate-700" },
    review: { text: "Outline ready: review it", tone: "bg-amber-950 text-amber-300 border-amber-800" },
    writing: { text: "Writing", tone: "bg-slate-800 text-slate-300 border-slate-700" },
    done: { text: "Finished", tone: "bg-emerald-950 text-emerald-300 border-emerald-800" },
  }[b.stage];
}

function Progress({ value, max }: { value: number; max: number }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 rounded bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-cyan-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

// --- New book ------------------------------------------------------------------

function NewBook({ onMade, onCancel }: { onMade: (id: string) => void; onCancel: () => void }) {
  const proj = useProjects();
  const [kind, setKind] = useState<Kind>("novel");
  const [f, setF] = useState({ brief: "", title: "", author: "", genre: "", audience: "", style: "", chapterCount: 20, chapterWords: 2500 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const pick = (k: Kind) => {
    setKind(k);
    setF((x) => ({ ...x, chapterCount: k === "novel" ? 20 : 10, chapterWords: k === "novel" ? 2500 : 1500 }));
  };
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await send<Book>("POST", "/api/books", { ...f, kind, project: proj.target });
      onMade(b.id);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  const novel = kind === "novel";
  return (
    <div className="max-w-2xl space-y-3">
      <h2 className="text-lg font-semibold text-slate-100">New book</h2>
      <div className="flex gap-2">
        {(["novel", "ebook"] as const).map((k) => (
          <button key={k} onClick={() => pick(k)} className={`${btn} border ${kind === k ? "border-cyan-600 bg-cyan-950 text-cyan-300" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
            {k === "novel" ? "Novel / fiction" : "Ebook / nonfiction"}
          </button>
        ))}
      </div>
      <label className="block text-xs text-slate-400">
        {novel ? "The story" : "What it teaches"}
        <textarea
          value={f.brief}
          onChange={(e) => set("brief", e.target.value)}
          rows={4}
          maxLength={6000}
          className={`${input} mt-1`}
          placeholder={
            novel
              ? "A lighthouse keeper on a remote Scottish island finds a message in a bottle written by her future self, warning her about the night of the great storm…"
              : "A practical guide for complete beginners to bake their first sourdough loaf at home, from starter to slicing, with a weekly schedule…"
          }
        />
      </label>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-xs text-slate-400">
          Title (optional: the Writer suggests one)
          <input value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={200} className={`${input} mt-1`} />
        </label>
        <label className="text-xs text-slate-400">
          Author name
          <input value={f.author} onChange={(e) => set("author", e.target.value)} maxLength={120} className={`${input} mt-1`} placeholder="Anonymous" />
        </label>
        <label className="text-xs text-slate-400">
          {novel ? "Genre" : "Topic area"}
          <input value={f.genre} onChange={(e) => set("genre", e.target.value)} maxLength={120} className={`${input} mt-1`} placeholder={novel ? "Cozy mystery, literary thriller…" : "Baking, personal finance…"} />
        </label>
        <label className="text-xs text-slate-400">
          Audience
          <input value={f.audience} onChange={(e) => set("audience", e.target.value)} maxLength={300} className={`${input} mt-1`} placeholder={novel ? "Adult readers, young adult…" : "Complete beginners, busy parents…"} />
        </label>
      </div>
      <label className="block text-xs text-slate-400">
        Style and voice
        <input
          value={f.style}
          onChange={(e) => set("style", e.target.value)}
          maxLength={1000}
          className={`${input} mt-1`}
          placeholder={novel ? "First person, present tense, wry and atmospheric, short chapters that end on hooks" : "Friendly and encouraging, plain English, a checklist at the end of each chapter"}
        />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-400">
          Chapters
          <input type="number" min={1} max={60} value={f.chapterCount} onChange={(e) => set("chapterCount", Number(e.target.value))} className={`${input} mt-1 w-24`} />
        </label>
        <label className="text-xs text-slate-400">
          Words per chapter
          <input type="number" min={300} max={8000} step={100} value={f.chapterWords} onChange={(e) => set("chapterWords", Number(e.target.value))} className={`${input} mt-1 w-32`} />
        </label>
        <p className="text-xs text-slate-500 pb-2">≈ {num(f.chapterCount * f.chapterWords)} words</p>
      </div>
      <p className="text-xs text-slate-500">
        The Writer plans first: a {novel ? "story bible (characters, setting, style, ending)" : "book plan (reader promise, voice, chapter pattern)"} and a chapter outline. Nothing is written until you've checked and approved
        the outline.
      </p>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy || f.brief.trim().length < 10} onClick={() => void create()} className={primary}>
          {busy ? "Creating…" : "Start planning"}
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
}

function OutlineEditor({ book, onSaved }: { book: Book; onSaved: (b: Book) => void }) {
  const [rows, setRows] = useState<Draft[]>(() => book.chapters.map((c, i) => ({ from: i, title: c.title, beats: c.beats })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = (i: number, k: "title" | "beats", v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
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
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="rounded border border-slate-800 bg-slate-900/50 p-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 w-6 text-right">{i + 1}</span>
            <input value={r.title} onChange={(e) => edit(i, "title", e.target.value)} maxLength={200} className={`${input} flex-1`} aria-label={`Chapter ${i + 1} title`} />
            <button onClick={() => move(i, -1)} disabled={i === 0} className="text-slate-500 hover:text-slate-200 disabled:opacity-30 px-1" aria-label="Move up">
              ↑
            </button>
            <button onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="text-slate-500 hover:text-slate-200 disabled:opacity-30 px-1" aria-label="Move down">
              ↓
            </button>
            <button onClick={() => setRows((x) => x.filter((_, j) => j !== i))} disabled={rows.length === 1} className="text-slate-500 hover:text-rose-300 disabled:opacity-30 px-1" aria-label="Remove chapter">
              ✕
            </button>
          </div>
          <textarea value={r.beats} onChange={(e) => edit(i, "beats", e.target.value)} rows={2} maxLength={3000} className={`${input} text-xs`} aria-label={`Chapter ${i + 1} beats`} />
        </div>
      ))}
      <button onClick={() => setRows((x) => [...x, { title: `Chapter ${x.length + 1}`, beats: "" }])} disabled={rows.length >= 60} className={quiet}>
        + Add chapter
      </button>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        <button disabled={busy} onClick={() => void save(true)} className={primary}>
          Approve and start writing
        </button>
        <button disabled={busy} onClick={() => void save(false)} className={quiet}>
          Save changes
        </button>
      </div>
    </div>
  );
}

// --- One chapter (writing and done) ---------------------------------------------

function ChapterRow({ book, ch, i, busy, onChange }: { book: Book; ch: Chapter; i: number; busy: boolean; onChange: (b: Book) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(ch.text ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const status = !ch.text ? "planned" : !ch.summary ? "drafting" : "written";
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
  return (
    <div className="border-b border-slate-800 last:border-0">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-3 py-2 text-left hover:bg-slate-900/60 px-1" aria-expanded={open}>
        <span className="text-xs text-slate-500 w-6 text-right">{i + 1}</span>
        <span className="flex-1 text-sm text-slate-200 truncate">{ch.title}</span>
        <span className={`text-[11px] ${status === "written" ? "text-emerald-400" : status === "drafting" ? "text-cyan-400" : "text-slate-500"}`}>
          {status === "planned" ? "planned" : `${num(ch.words ?? 0)} words`}
        </span>
      </button>
      {open && (
        <div className="pl-9 pr-1 pb-3 space-y-2">
          <p className="text-xs text-slate-400">
            <span className="text-slate-500">{book.kind === "novel" ? "Beats" : "Covers"}:</span> {ch.beats || "—"}
          </p>
          {ch.note && <p className="text-xs text-amber-300">Your note: {ch.note}</p>}
          {editing ? (
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} className={`${input} font-serif leading-relaxed`} />
          ) : ch.text ? (
            <div className="max-h-96 overflow-y-auto rounded bg-slate-950 border border-slate-800 p-3 text-sm text-slate-300 font-serif leading-relaxed whitespace-pre-wrap">{ch.text}</div>
          ) : null}
          {ch.summary && !editing && (
            <p className="text-[11px] text-slate-500">
              <span className="text-slate-400">Continuity note:</span> {ch.summary}
            </p>
          )}
          {ch.model && <p className="text-[11px] text-slate-600">Written by {ch.model}</p>}
          {error && <p className="text-xs text-rose-300">{error}</p>}
          {ch.text && (
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
                  <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Note for a rewrite (optional): more dialogue, slower pace…" className={`${input} text-xs flex-1 min-w-48`} />
                  <button disabled={busy} onClick={() => void act(() => send<Book>("POST", `/api/books/${book.id}/chapters/${i}/rewrite`, { note }))} className={quiet}>
                    Rewrite
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

// --- One book --------------------------------------------------------------------

function BookView({ id, meta, onGone, onChanged }: { id: string; meta: ListReply | null; onGone: () => void; onChanged: () => void }) {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bibleOpen, setBibleOpen] = useState(false);
  const [bible, setBible] = useState("");
  const [trim, setTrim] = useState("6x9");
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
  const active = Boolean(book?.running) || ((book?.stage === "planning" || book?.stage === "writing") && !book?.paused);
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
  const hasText = book.chapters.some((c) => c.text);
  const busy = Boolean(book.running);
  const exportUrl = (fmt: string) => `${HARNESS_URL}/api/books/${book.id}/export/${fmt}`;

  const setCover = async (file: File | undefined) => {
    if (!file) return;
    await act(async () => send<Book>("PATCH", `/api/books/${book.id}`, { cover: await uploadImage(file) }));
  };
  const makePdf = async () => {
    setPdf({ busy: true });
    try {
      const out = await send<{ name: string }>("POST", `/api/books/${book.id}/pdf`, { trim });
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
            {book.kind === "novel" ? "Novel" : "Ebook"} · by {book.author} · {num(words)} of ~{num(book.chapterCount * book.chapterWords)} words
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className={`text-[11px] px-2 py-0.5 rounded border ${st.tone}`}>{st.text}</span>
            {book.next && !book.running && !book.paused && <span className="text-[11px] text-slate-500">Next: {book.next} (runs when no card is waiting)</span>}
          </div>
          <label className="inline-block text-[11px] text-cyan-400 hover:text-cyan-300 cursor-pointer pt-1">
            {book.cover ? "Change cover" : "Add a cover picture"}
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
        {!busy && !hasText && book.bible && (
          <>
            <button onClick={() => void act(() => send<Book>("POST", `/api/books/${book.id}/replan`, { what: "outline" }))} className={quiet}>
              New outline
            </button>
            <button onClick={() => void act(() => send<Book>("POST", `/api/books/${book.id}/replan`, { what: "bible" }))} className={quiet}>
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
            {book.running.label}… <span className="text-slate-500">({meta?.writer ?? "Writer"})</span>
          </p>
          <div ref={live} className="max-h-64 overflow-y-auto px-3 py-2 text-sm text-slate-300 font-serif leading-relaxed whitespace-pre-wrap">
            {book.running.text || "Waiting for the first words…"}
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
            <select value={trim} onChange={(e) => setTrim(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" aria-label="Page size">
              {(meta?.trims ?? ["6x9"]).map((t) => (
                <option key={t} value={t}>
                  {t === "a5" ? "A5" : t === "letter" ? "US Letter" : `${t} in`}
                </option>
              ))}
            </select>
            <button disabled={pdf.busy || meta?.pdf === false} onClick={() => void makePdf()} className={quiet} title={meta?.pdf === false ? "PDFs need the browser sidecar (BROWSER_CDP_URL)" : undefined}>
              {pdf.busy ? "Printing…" : "Print-ready PDF"}
            </button>
            {pdf.url && (
              <a href={pdf.url} className="text-xs text-cyan-400 hover:text-cyan-300">
                Download PDF
              </a>
            )}
          </div>
          {pdf.error && <p className="text-xs text-rose-300">{pdf.error}</p>}
          {book.stage !== "done" && <p className="text-[11px] text-slate-500">Downloads include the chapters written so far.</p>}
        </section>
      )}

      <section className="space-y-2">
        <button onClick={() => (setBible(book.bible), setBibleOpen((o) => !o))} className="text-sm font-medium text-slate-200 hover:text-cyan-300" aria-expanded={bibleOpen}>
          {bibleOpen ? "▾" : "▸"} {book.kind === "novel" ? "Story bible" : "Book plan"} {book.bible ? "" : "(not written yet)"}
        </button>
        {bibleOpen && (
          <div className="space-y-2">
            <p className="text-[11px] text-slate-500">Every chapter is written with this in view. Fix names, the ending or the style here and later chapters follow it.</p>
            <textarea value={bible} onChange={(e) => setBible(e.target.value)} rows={16} className={`${input} text-xs font-mono`} />
            <button disabled={busy} onClick={() => void act(() => send<Book>("PATCH", `/api/books/${book.id}`, { bible }))} className={quiet}>
              Save
            </button>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-slate-200">
          {book.stage === "review" ? "Outline: edit it, then approve" : "Chapters"} {book.chapters.length ? `(${book.chapters.length})` : ""}
        </h3>
        {!book.chapters.length ? (
          <p className="text-xs text-slate-500">{book.stage === "planning" ? "The outline comes after the plan." : "No chapters."}</p>
        ) : book.stage === "review" ? (
          <OutlineEditor key={book.updatedAt} book={book} onSaved={update} />
        ) : (
          <div className="rounded border border-slate-800 px-2">
            {book.chapters.map((c, i) => (
              <ChapterRow key={`${i}-${c.title}-${c.words ?? 0}`} book={book} ch={c} i={i} busy={busy} onChange={update} />
            ))}
          </div>
        )}
      </section>

      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer hover:text-slate-300">The brief</summary>
        <p className="mt-2 whitespace-pre-wrap text-slate-400">{book.brief}</p>
        <p className="mt-1">
          {[book.genre, book.audience, book.style].filter(Boolean).join(" · ")} · {book.chapterWords} words per chapter
        </p>
      </details>
    </div>
  );
}

// --- The page ----------------------------------------------------------------------

export default function BooksPage() {
  const proj = useProjects();
  const [list, setList] = useState<ListReply | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);
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
          <button onClick={() => setSelected("new")} className={primary}>
            + New book
          </button>
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
                <span className="text-[10px] text-slate-500 uppercase">{b.kind}</span>
              </div>
              <Progress value={b.words} max={b.target} />
              <div className="flex justify-between text-[11px]">
                <span className={st.tone.split(" ").find((c) => c.startsWith("text-"))}>{b.running ?? st.text}</span>
                <span className="text-slate-500">
                  {b.written}/{b.chapterTotal || "?"} ch · {num(b.words)} w
                </span>
              </div>
            </button>
          );
        })}
        {list && !list.books.length && <p className="px-3 py-2 text-xs text-slate-500">No books yet.</p>}
      </aside>
      <main className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded-xl overflow-y-auto p-4 md:p-6">
        {selected === "new" ? (
          <NewBook
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
