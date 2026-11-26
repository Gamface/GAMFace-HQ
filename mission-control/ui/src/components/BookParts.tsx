import { useState } from "react";
import { fileUrl, send, uploadAudio, uploadPdf } from "../api";

// Pieces of the Books page: shared types, source material (your own content), the
// listing kit and the KDP paperback files.

export type Kind = "novel" | "ebook" | "picture" | "puzzle";
export type Stage = "planning" | "review" | "writing" | "done";

export interface PuzzleView {
  categories: string[];
  clues: string[];
  crime?: string;
  answer?: string;
  rows: string[][];
  difficulty: string;
}

export interface Chapter {
  title: string;
  beats: string;
  text?: string;
  summary?: string;
  words?: number;
  note?: string;
  model?: string;
  image?: string;
  sources?: number[];
  puzzleView?: PuzzleView;
}

export interface SourceInfo {
  id: string;
  kind: string;
  name: string;
  origin?: string;
  chars: number;
  preview: string;
}

export interface Listing {
  description: string;
  backCover: string;
  keywords: string[];
  categories: string[];
  subtitle?: string;
  ageRange?: string;
}

export interface Book {
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
  next: string | null;
  updatedAt: number;
  genre: string;
  audience: string;
  style: string;
  chapterCount: number;
  chapterWords: number;
  bible: string;
  chapters: Chapter[];
  cover?: string;
  running: { label: string; text: string; startedAt: number } | null;
  sources: SourceInfo[];
  sourceParts: number;
  digested: number;
  faithful?: boolean;
  art?: { style: string; characters: string; seed: number; off?: boolean };
  puzzle?: { type: "logic" | "mystery"; difficulty: "easy" | "medium" | "hard" };
  trim?: string;
  listing?: Listing;
  wantListing?: boolean;
  /** The cover's colours as the book set them (left out: picked from the title) */
  coverColors?: { bg: string; fg: string; accent: string; source: string; palette?: string; locked?: boolean; band?: string };
  /** The colours the cover prints with */
  colors?: { bg: string; fg: string; accent: string; band: string };
  ebookCover?: string;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");
export const input = "w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";
export const btn = "px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50";
export const primary = `${btn} bg-cyan-600 hover:bg-cyan-500 text-white`;
export const quiet = `${btn} border border-slate-700 text-slate-300 hover:bg-slate-800`;
export const num = (n: number) => n.toLocaleString();
export const trimLabel = (t: string) => (t === "a5" ? "A5" : t === "letter" ? "US Letter" : `${t.replace("x", "×")} in`);
export const KIND_LABEL: Record<Kind, string> = { novel: "Novel", ebook: "Ebook", picture: "Picture book", puzzle: "Puzzle book" };

const readAs = (file: File, how: "text" | "dataUrl") =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
    if (how === "text") r.readAsText(file);
    else r.readAsDataURL(file);
  });

/** A source waiting to be added (the new-book form collects them before the book exists). */
export type PendingSource = { kind: "url"; url: string } | { kind: "text"; name: string; text: string } | { kind: "file"; file: File };

export const pendingName = (s: PendingSource) => (s.kind === "url" ? s.url : s.kind === "text" ? s.name : s.file.name);

/** Sends one source to a book, uploading or reading files as needed. */
export async function addSource(bookId: string, s: PendingSource): Promise<Book> {
  const path = `/api/books/${bookId}/sources`;
  if (s.kind === "url") return send<Book>("POST", path, { kind: "url", url: s.url });
  if (s.kind === "text") return send<Book>("POST", path, { kind: "text", name: s.name, text: s.text });
  const f = s.file;
  const lower = f.name.toLowerCase();
  if (lower.endsWith(".pdf") || f.type === "application/pdf") {
    const doc = await uploadPdf(f);
    return send<Book>("POST", path, { kind: "pdf", upload: doc.id, name: f.name });
  }
  if (lower.endsWith(".docx")) return send<Book>("POST", path, { kind: "docx", name: f.name, data: await readAs(f, "dataUrl") });
  if (f.type.startsWith("audio/") || f.type.startsWith("video/") || /\.(mp3|m4a|wav|ogg|webm|mp4|aac|flac)$/.test(lower)) {
    const up = await uploadAudio(f);
    return send<Book>("POST", path, { kind: "audio", upload: up.id, name: f.name });
  }
  if (/\.(txt|md|markdown|html?)$/.test(lower) || f.type.startsWith("text/")) return send<Book>("POST", path, { kind: "text", name: f.name, text: await readAs(f, "text") });
  throw new Error(`${f.name}: use a PDF, Word (.docx), text or Markdown file, or a recording`);
}

/** Where your content comes from: web addresses, files and pasted text. */
export function SourcePicker({ onAdd, busy }: { onAdd: (s: PendingSource[]) => void; busy?: boolean }) {
  const [urls, setUrls] = useState("");
  const [paste, setPaste] = useState("");
  const addUrls = () => {
    const list = urls
      .split(/\s+/)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u));
    if (list.length) onAdd(list.map((url) => ({ kind: "url", url })));
    setUrls("");
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <textarea
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          rows={2}
          className={`${input} text-xs`}
          placeholder="Web addresses, one per line: blog posts, a public Google Doc, YouTube videos (their captions), PDF links"
          aria-label="Web addresses"
        />
        <button disabled={busy || !urls.trim()} onClick={addUrls} className={`${quiet} shrink-0 self-start`}>
          Add
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${quiet} cursor-pointer`}>
          Add files
          <input
            type="file"
            multiple
            className="hidden"
            accept=".pdf,.docx,.txt,.md,.markdown,.html,.htm,audio/*,.mp3,.m4a,.wav"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              if (files.length) onAdd(files.map((file) => ({ kind: "file", file })));
              e.target.value = "";
            }}
          />
        </label>
        <span className="text-[11px] text-slate-500">PDF, Word (.docx), text or Markdown, or a recording (transcribed on your PC; up to about 13 minutes each)</span>
      </div>
      <div className="flex gap-2">
        <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={2} className={`${input} text-xs`} placeholder="…or paste text: notes, a transcript, an old draft" aria-label="Pasted text" />
        <button
          disabled={busy || paste.trim().length < 50}
          onClick={() => {
            onAdd([{ kind: "text", name: paste.trim().split("\n")[0].slice(0, 60) || "Pasted text", text: paste }]);
            setPaste("");
          }}
          className={`${quiet} shrink-0 self-start`}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/** A book's sources: what's there, and adding or removing more. */
export function SourcesPanel({ book, onChange, busy }: { book: Book; onChange: (b: Book) => void; busy: boolean }) {
  const [open, setOpen] = useState(book.stage === "planning" && book.sources.length === 0);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = async (list: PendingSource[]) => {
    setError(null);
    for (const s of list) {
      setWorking(`Adding ${pendingName(s)}…`);
      try {
        onChange(await addSource(book.id, s));
      } catch (e) {
        setError(`${pendingName(s)}: ${errText(e)}`);
      }
    }
    setWorking(null);
  };
  const remove = async (id: string) => {
    try {
      onChange(await send<Book>("DELETE", `/api/books/${book.id}/sources/${id}`));
    } catch (e) {
      setError(errText(e));
    }
  };
  const chars = book.sources.reduce((n, s) => n + s.chars, 0);
  return (
    <section className="space-y-2">
      <button onClick={() => setOpen((o) => !o)} className="text-sm font-medium text-slate-200 hover:text-cyan-300" aria-expanded={open}>
        {open ? "▾" : "▸"} Your content {book.sources.length ? `(${book.sources.length} source${book.sources.length > 1 ? "s" : ""}, ≈ ${num(Math.round(chars / 6))} words)` : "(none: written from the brief)"}
      </button>
      {open && (
        <div className="space-y-3 rounded border border-slate-800 p-3">
          {book.sources.length > 0 && (
            <>
              <ul className="space-y-1.5">
                {book.sources.map((s) => (
                  <li key={s.id} className="flex items-start gap-2 text-xs">
                    <span className="text-[10px] uppercase text-slate-500 w-14 shrink-0 pt-0.5">{s.kind}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-slate-200 truncate" title={s.origin ?? s.name}>
                        {s.name}
                      </p>
                      <p className="text-slate-500 truncate">{s.preview}</p>
                    </div>
                    <span className="text-slate-500 shrink-0">≈ {num(Math.round(s.chars / 6))} w</span>
                    <button disabled={busy} onClick={() => void remove(s.id)} className="text-slate-500 hover:text-rose-300 disabled:opacity-30" aria-label={`Remove ${s.name}`}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              {book.sourceParts > 0 && book.stage === "planning" && (
                <p className="text-[11px] text-slate-500">
                  Read in {book.sourceParts} parts; notes taken on {book.digested} so far.
                </p>
              )}
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={book.faithful !== false}
                  disabled={busy}
                  onChange={async (e) => {
                    try {
                      onChange(await send<Book>("PATCH", `/api/books/${book.id}`, { faithful: e.target.checked }));
                    } catch (err) {
                      setError(errText(err));
                    }
                  }}
                />
                Stay true to my content (repurpose it; don't add facts that aren't in it)
              </label>
            </>
          )}
          {book.stage !== "planning" && book.sources.length > 0 && <p className="text-[11px] text-slate-500">New sources are used by chapters written from now on; the outline stays as it is.</p>}
          <SourcePicker onAdd={(l) => void add(l)} busy={busy || Boolean(working)} />
          {working && <p className="text-xs text-cyan-300">{working}</p>}
          {error && <p className="text-xs text-rose-300">{error}</p>}
        </div>
      )}
    </section>
  );
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="text-[11px] text-cyan-400 hover:text-cyan-300"
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** The listing kit: description, back cover, keywords and categories for the store page. */
export function ListingPanel({ book, onChange }: { book: Book; onChange: (b: Book) => void }) {
  const [error, setError] = useState<string | null>(null);
  const ask = async () => {
    setError(null);
    try {
      onChange(await send<Book>("POST", `/api/books/${book.id}/listing`));
    } catch (e) {
      setError(errText(e));
    }
  };
  const l = book.listing;
  const waiting = book.wantListing && !l;
  return (
    <section className="rounded border border-slate-800 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-slate-200 flex-1">Listing kit</h3>
        <button disabled={!book.bible || waiting} onClick={() => void ask()} className={quiet}>
          {waiting ? "Writing it…" : l ? "Write it again" : "Write the listing"}
        </button>
      </div>
      {!l && !waiting && <p className="text-[11px] text-slate-500">A store description, back-cover text, 7 keyword phrases and 3 categories for Amazon KDP (or Etsy, Gumroad…).</p>}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {l && (
        <div className="space-y-3 text-xs">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-slate-400 flex-1">Description (HTML for the KDP description box)</span>
              <Copy text={l.description} />
            </div>
            <div className="rounded bg-slate-950 border border-slate-800 p-2 text-slate-300 max-h-48 overflow-y-auto [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: l.description }} />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-slate-400 flex-1">Back cover</span>
              <Copy text={l.backCover} />
            </div>
            <p className="text-slate-300 whitespace-pre-wrap">{l.backCover}</p>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-slate-400 flex-1">Keywords (KDP's 7 boxes)</span>
              <Copy text={l.keywords.join("\n")} label="Copy all" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {l.keywords.map((k) => (
                <span key={k} className="px-2 py-0.5 rounded bg-slate-800 text-slate-200">
                  {k}
                </span>
              ))}
            </div>
          </div>
          {l.categories.length > 0 && (
            <div>
              <span className="text-slate-400">Categories</span>
              <ul className="text-slate-300 list-disc pl-5">
                {l.categories.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {l.subtitle && !book.subtitle && (
            <p className="text-slate-400">
              Suggested subtitle: <span className="text-slate-200">{l.subtitle}</span>{" "}
              <button onClick={() => void send<Book>("PATCH", `/api/books/${book.id}`, { subtitle: l.subtitle }).then(onChange)} className="text-cyan-400 hover:text-cyan-300">
                Use it
              </button>
            </p>
          )}
          {l.ageRange && <p className="text-slate-400">Reading age: {l.ageRange}</p>}
          <p className="text-[11px] text-amber-300/90">
            KDP asks whether a book's text, images or translation are AI-generated: answer yes for what the Writer or the picture tool made. Check facts, names and claims before you publish.
          </p>
        </div>
      )}
    </section>
  );
}

interface KdpResult {
  interior: { name: string; pages: number };
  cover: { name: string; width: number; height: number; spine: number; pixels: [number, number] };
  trim: string;
  paper: string;
  notes: string[];
}

/** KDP paperback files: interior and full cover, sized for each other. */
export function KdpPanel({ book, trims, available }: { book: Book; trims: string[]; available: boolean }) {
  const [trim, setTrim] = useState(book.trim ?? (book.kind === "picture" ? "8.5x8.5" : book.kind === "puzzle" ? "8.5x11" : "6x9"));
  const [paper, setPaper] = useState(book.kind === "picture" ? "color" : "white");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<KdpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      setOut(await send<KdpResult>("POST", `/api/books/${book.id}/kdp`, { trim, paper }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded border border-slate-800 p-3 space-y-2">
      <h3 className="text-sm font-medium text-slate-200">Amazon KDP paperback</h3>
      <div className="flex flex-wrap items-center gap-2">
        <select value={trim} onChange={(e) => setTrim(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" aria-label="Trim size">
          {trims.map((t) => (
            <option key={t} value={t}>
              {trimLabel(t)}
            </option>
          ))}
        </select>
        <select value={paper} onChange={(e) => setPaper(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" aria-label="Paper">
          <option value="white">White paper (black ink)</option>
          <option value="cream">Cream paper (black ink)</option>
          <option value="color">Premium colour</option>
        </select>
        <button disabled={busy || !available} onClick={() => void make()} className={primary} title={available ? undefined : "KDP files are printed by the browser sidecar (BROWSER_CDP_URL)"}>
          {busy ? "Making the files…" : "Make interior + cover"}
        </button>
      </div>
      <p className="text-[11px] text-slate-500">The inside margin follows KDP's rules for the page count, short books are padded to 24 pages, and the cover's spine is sized for the paper. Check both files in KDP's previewer.</p>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {out && (
        <div className="text-xs space-y-1.5">
          <div className="flex flex-wrap gap-3">
            <a href={fileUrl(out.interior.name, true)} className="text-cyan-400 hover:text-cyan-300">
              Interior PDF ({out.interior.pages} pages)
            </a>
            <a href={fileUrl(out.cover.name, true)} className="text-cyan-400 hover:text-cyan-300">
              Cover PDF ({out.cover.width} × {out.cover.height} in, spine {out.cover.spine} in)
            </a>
          </div>
          <ul className="text-slate-400 list-disc pl-5">
            {out.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
