// Books: novels and nonfiction ebooks, written one step at a time so a local model with
// an 8K context can still finish a 50,000-word manuscript.
//
//   brief → story bible (characters, setting, style; or the reader promise for an ebook)
//         → chapter outline (JSON) → waits for you to edit and approve it
//         → each chapter in order: write it, keep going if the model stopped short,
//           then summarize it so later chapters remember what happened
//         → Markdown, EPUB and print-ready PDF
//
// Every step is one model call through the gateway (the Writer agent's model), run by
// the queue between cards, and the book is saved after each one, so a restart, a stop or
// a failed call loses at most the chapter that was being written.

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./ollama";
import { BOOK_CSS, buildEpub, toXhtml, xmlEsc } from "./epub";
import type { EpubInput } from "./epub";
import { renderMarkdown } from "./markdown";

export type BookKind = "novel" | "ebook";
export type BookStage = "planning" | "review" | "writing" | "done";

export interface Chapter {
  title: string;
  /** What happens (novel) or what it covers (ebook): the outline the writer follows */
  beats: string;
  text?: string;
  /** A short continuity summary, written after the chapter */
  summary?: string;
  words?: number;
  /** How many calls wrote it (1, plus one per "keep going") */
  parts?: number;
  /** Your note for a rewrite ("more dialogue", "cut the flashback") */
  note?: string;
  model?: string;
}

export interface Book {
  id: string;
  title: string;
  subtitle?: string;
  author: string;
  language: string;
  kind: BookKind;
  /** What the user asked for, in their words */
  brief: string;
  genre: string;
  audience: string;
  style: string;
  chapterCount: number;
  chapterWords: number;
  project: string | null;
  bible: string;
  chapters: Chapter[];
  stage: BookStage;
  paused?: boolean;
  error?: string;
  failures?: number;
  /** An uploaded picture used as the cover */
  cover?: string;
  /** A stable id for the EPUB */
  uuid: string;
  createdAt: number;
  updatedAt: number;
}

export type BookStep =
  | { kind: "bible" }
  | { kind: "outline" }
  | { kind: "chapter"; n: number }
  | { kind: "continue"; n: number }
  | { kind: "summary"; n: number };

export const BOOK_ID = /^[a-f0-9]{12}$/;
export const MAX_CHAPTERS = 60;
export const MAX_CHAPTER_WORDS = 8000;
/** A chapter shorter than this share of its target gets another call */
const SHORT = 0.6;
const MAX_PARTS = 3;
const MAX_FAILURES = 2;

export const countWords = (s: string) => (s.match(/\S+/g) ?? []).length;

// --- Creating and editing --------------------------------------------------------

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Checks a new book's settings. Returns the book, or what's wrong. */
export function newBook(input: Record<string, unknown>, now = Date.now()): Book | { error: string } {
  const kind: BookKind = input.kind === "ebook" ? "ebook" : "novel";
  const brief = str(input.brief, 6000);
  if (brief.length < 10) return { error: kind === "novel" ? "Describe the story you want (a sentence or two at least)" : "Describe what the ebook should teach or cover" };
  const project = typeof input.project === "string" && input.project && input.project !== "general" ? input.project : null;
  return {
    id: randomBytes(6).toString("hex"),
    title: str(input.title, 200),
    subtitle: str(input.subtitle, 200) || undefined,
    author: str(input.author, 120) || "Anonymous",
    language: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(str(input.language, 12)) ? str(input.language, 12) : "en",
    kind,
    brief,
    genre: str(input.genre, 120),
    audience: str(input.audience, 300),
    style: str(input.style, 1000),
    chapterCount: int(input.chapterCount, 1, MAX_CHAPTERS, kind === "novel" ? 20 : 10),
    chapterWords: int(input.chapterWords, 300, MAX_CHAPTER_WORDS, kind === "novel" ? 2500 : 1500),
    project,
    bible: "",
    chapters: [],
    stage: "planning",
    paused: input.start === false ? true : undefined,
    uuid: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Applies edits from the Books page. While a step is running only pausing is allowed;
 * chapter text can be edited by hand (its summary is then rewritten).
 */
export function editBook(book: Book, input: Record<string, unknown>): string | null {
  for (const k of ["title", "subtitle", "author", "genre", "audience", "style"] as const) {
    if (typeof input[k] === "string") (book as unknown as Record<string, unknown>)[k] = str(input[k], k === "style" ? 1000 : k === "audience" ? 300 : 200) || (k === "author" ? "Anonymous" : k === "subtitle" ? undefined : "");
  }
  if (typeof input.brief === "string") {
    if (str(input.brief, 6000).length < 10) return "The brief is too short";
    book.brief = str(input.brief, 6000);
  }
  if (typeof input.bible === "string") book.bible = str(input.bible, 20000);
  if (input.chapterWords !== undefined) book.chapterWords = int(input.chapterWords, 300, MAX_CHAPTER_WORDS, book.chapterWords);
  if (input.cover === null || input.cover === "") book.cover = undefined;
  else if (typeof input.cover === "string") book.cover = input.cover;
  if (Array.isArray(input.chapters)) {
    if (input.chapters.length > MAX_CHAPTERS) return `At most ${MAX_CHAPTERS} chapters`;
    if (!input.chapters.length) return "A book needs at least one chapter";
    const next: Chapter[] = [];
    for (const raw of input.chapters as unknown[]) {
      const c = (raw ?? {}) as Record<string, unknown>;
      // An existing chapter is referred to by its index, so moving chapters keeps their text
      const from = typeof c.from === "number" && Number.isInteger(c.from) ? book.chapters[c.from] : undefined;
      const title = str(c.title, 200) || from?.title || `Chapter ${next.length + 1}`;
      const beats = typeof c.beats === "string" ? str(c.beats, 3000) : (from?.beats ?? "");
      const ch: Chapter = from ? { ...from, title, beats } : { title, beats };
      if (typeof c.text === "string") {
        const text = c.text.trim();
        if (text !== (from?.text ?? "")) {
          ch.text = text || undefined;
          ch.words = text ? countWords(text) : undefined;
          ch.summary = undefined; // rewritten from the new text
          ch.parts = text ? MAX_PARTS : undefined; // edited by hand: never "kept going"
        }
      }
      if (typeof c.note === "string") ch.note = str(c.note, 1000) || undefined;
      next.push(ch);
    }
    book.chapters = next;
    book.chapterCount = next.length;
    // Planned chapters added to a finished book get written
    if (book.stage === "done" && next.some((c) => !c.text || !c.summary)) book.stage = "writing";
  }
  return null;
}

/** Clears a chapter so it's written again (with your note, if any). Later chapters are kept. */
export function rewriteChapter(book: Book, n: number, note?: string): string | null {
  const ch = book.chapters[n];
  if (!ch) return "No such chapter";
  if (book.stage === "planning" || book.stage === "review") return "Approve the outline first";
  book.chapters[n] = { title: ch.title, beats: ch.beats, note: note?.trim().slice(0, 1000) || undefined };
  book.stage = "writing";
  book.paused = false;
  book.error = undefined;
  book.failures = 0;
  return null;
}

// --- What runs next ---------------------------------------------------------------

/** The next step for a book, or null when it's waiting for you, paused or finished. */
export function nextStep(book: Book): BookStep | null {
  if (book.paused) return null;
  if (book.stage === "planning") {
    if (!book.bible.trim()) return { kind: "bible" };
    if (!book.chapters.length) return { kind: "outline" };
    return null;
  }
  if (book.stage !== "writing") return null;
  for (let n = 0; n < book.chapters.length; n++) {
    const c = book.chapters[n];
    if (!c.text) return { kind: "chapter", n };
    if ((c.parts ?? 1) < MAX_PARTS && (c.words ?? countWords(c.text)) < book.chapterWords * SHORT) return { kind: "continue", n };
    if (!c.summary) return { kind: "summary", n };
  }
  return null;
}

/** "Writing chapter 3 of 20" and friends. */
export function describeStep(book: Book, step: BookStep): string {
  const of = `${"n" in step ? step.n + 1 : ""} of ${book.chapters.length}`;
  switch (step.kind) {
    case "bible":
      return book.kind === "novel" ? "Planning the story bible" : "Planning the book";
    case "outline":
      return "Outlining the chapters";
    case "chapter":
      return `Writing chapter ${of}`;
    case "continue":
      return `Continuing chapter ${of}`;
    case "summary":
      return `Summarizing chapter ${of}`;
  }
}

// --- Prompts ----------------------------------------------------------------------

const label = (book: Book) => (book.kind === "novel" ? "novel" : "nonfiction ebook");

function briefBlock(book: Book): string {
  return [
    book.title && `Working title: ${book.title}${book.subtitle ? ` — ${book.subtitle}` : ""}`,
    `Brief: ${book.brief}`,
    book.genre && `${book.kind === "novel" ? "Genre" : "Topic area"}: ${book.genre}`,
    book.audience && `Audience: ${book.audience}`,
    book.style && `Style and voice: ${book.style}`,
    `Length: ${book.chapterCount} chapters of about ${book.chapterWords} words (${(book.chapterCount * book.chapterWords).toLocaleString("en-US")} words in all)`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function biblePrompt(book: Book): ChatMessage[] {
  const sections =
    book.kind === "novel"
      ? "## Logline (one sentence)\n## Characters (3–8: name — role, what they want, their flaw, how they talk)\n## Setting (time, place, rules of the world)\n## Themes\n## Style guide (point of view, tense, tone, prose rules to follow in every chapter)\n## Arc (beginning, midpoint, climax and how it ends: plan the ending now)"
      : "## Reader promise (what the reader can do or understand after reading)\n## Audience (who they are, what they already know, what they struggle with)\n## Voice and style (tone, reading level, how examples and exercises are used)\n## Key terms (the words this book uses, defined once)\n## Chapter pattern (what every chapter contains, in order)\n## Arc (how the chapters build from first steps to the outcome)";
  return [
    { role: "system", content: `You are a developmental editor planning a ${label(book)} for an author. You write clear, specific planning documents, not prose.` },
    {
      role: "user",
      content: `${briefBlock(book)}\n\nWrite the ${book.kind === "novel" ? "STORY BIBLE" : "BOOK PLAN"} in Markdown, under 700 words, with exactly these sections:\n${sections}\n\nBe concrete: real names, specific places and decisions, no placeholders. Write only the document.`,
    },
  ];
}

export function outlinePrompt(book: Book): ChatMessage[] {
  const what = book.kind === "novel" ? "what happens: the scenes, who is in them, what changes, and the hook that leads into the next chapter" : "what it teaches: the key points in order, one example or exercise, and what the reader can do afterwards";
  return [
    { role: "system", content: `You plan ${label(book)}s chapter by chapter. Reply with JSON only.` },
    {
      role: "user",
      content:
        `${briefBlock(book)}\n\n${book.kind === "novel" ? "STORY BIBLE" : "BOOK PLAN"}:\n${book.bible}\n\n` +
        `Plan exactly ${book.chapterCount} chapters that follow the ${book.kind === "novel" ? "arc" : "plan"} above from start to finish. ` +
        `For each chapter give a title and "beats": 3–5 sentences on ${what}.\n` +
        `Reply as {"title": "the book's title", "subtitle": "optional", "chapters": [{"title": "…", "beats": "…"}]}`,
    },
  ];
}

/** Parses the outline reply. Returns the chapters, or why it can't be used. */
export function parseOutline(json: Record<string, unknown>, want: number): { title?: string; subtitle?: string; chapters: Chapter[] } | { error: string } {
  const list = Array.isArray(json.chapters) ? json.chapters : Array.isArray(json.outline) ? json.outline : null;
  if (!list?.length) return { error: "The outline had no chapters" };
  const chapters: Chapter[] = [];
  for (const raw of list.slice(0, MAX_CHAPTERS)) {
    const c = (typeof raw === "string" ? { title: raw } : (raw ?? {})) as Record<string, unknown>;
    const beats = Array.isArray(c.beats) ? c.beats.map(String).join(" ") : str(c.beats ?? c.summary ?? c.description ?? c.points, 3000);
    const title = str(c.title ?? c.name, 200).replace(/^(chapter\s+\d+\s*[:.\-–—]\s*)/i, "");
    if (!title && !beats) continue;
    chapters.push({ title: title || `Chapter ${chapters.length + 1}`, beats });
  }
  if (!chapters.length) return { error: "The outline had no usable chapters" };
  // A model that planned too few is taken at its word; too many are cut to the length asked for
  return { title: str(json.title, 200) || undefined, subtitle: str(json.subtitle, 200) || undefined, chapters: chapters.slice(0, Math.max(want, 1)) };
}

function writerSystem(book: Book): string {
  const rules =
    book.kind === "novel"
      ? [
          "You are a skilled novelist writing one chapter of a novel at a time.",
          "Write only the chapter's prose in Markdown: no chapter heading or title, no notes, no summary, no \"to be continued\".",
          "Follow the story bible's style guide (point of view, tense, tone) exactly. Show, don't tell: scenes, action, sensory detail and dialogue.",
          "Stay consistent with the characters, facts and events already established. Cover this chapter's beats and nothing planned for later chapters.",
          "For a scene break write a line with only *** on it. End the chapter on its hook.",
        ]
      : [
          "You are an expert nonfiction author writing one chapter of an ebook at a time.",
          "Write only the chapter in Markdown: no chapter heading (it's added for you); use ## and ### subheadings, short paragraphs, lists and the occasional table.",
          "Be practical and specific: concrete examples, steps the reader can follow, and a short recap at the end.",
          "Don't invent statistics, studies, quotes or sources. When something needs evidence, say so in general terms rather than making up numbers.",
          "Follow the book plan's voice and chapter pattern, and don't repeat what earlier chapters already covered.",
        ];
  return `${rules.join("\n")}\n\n${book.kind === "novel" ? "STORY BIBLE" : "BOOK PLAN"} — ${book.title || "untitled"}:\n${book.bible}`;
}

const firstSentence = (s: string) => (/^.+?[.!?](\s|$)/.exec(s.replace(/\s+/g, " ").trim())?.[0] ?? s).trim().slice(0, 200);

/**
 * What the writer sees for chapter n, shrunk to fit `budget` characters: the outline
 * (far chapters by title only), the story so far (older chapters cut to a sentence,
 * then dropped), and the end of the previous chapter.
 */
export function chapterPrompt(book: Book, n: number, budget: number): ChatMessage[] {
  const system = writerSystem(book);
  const ch = book.chapters[n];
  const prev = n > 0 ? book.chapters[n - 1].text ?? "" : "";
  const build = (level: number): string => {
    const near = level >= 1 ? 2 : Infinity;
    const outline = book.chapters
      .map((c, i) => `${i + 1}. ${c.title}${Math.abs(i - n) <= near && i !== n ? ` — ${c.beats.replace(/\s+/g, " ").trim()}` : ""}`)
      .join("\n");
    const done = book.chapters.slice(0, n);
    const keepFull = level >= 2 ? 3 : Infinity;
    const drop = level >= 3 ? Math.max(0, done.length - 6) : 0;
    const sofar = done
      .map((c, i) => {
        if (i < drop) return null;
        const s = c.summary || firstSentence(c.text ?? "") || c.beats;
        return `Chapter ${i + 1} (${c.title}): ${done.length - i > keepFull ? firstSentence(s) : s}`;
      })
      .filter(Boolean);
    if (drop) sofar.unshift(`(Chapters 1–${drop} happened earlier; see the outline.)`);
    const tail = prev ? prev.slice(-(level >= 4 ? 600 : 1800)).replace(/^\S*\s/, "…") : "";
    return [
      `OUTLINE:\n${outline}`,
      sofar.length ? `${book.kind === "novel" ? "STORY SO FAR" : "COVERED SO FAR"}:\n${sofar.join("\n")}` : "",
      tail ? `END OF CHAPTER ${n}:\n${tail}` : "",
      `NOW WRITE CHAPTER ${n + 1}: ${ch.title}\n${book.kind === "novel" ? "Beats" : "Covers"}: ${ch.beats}` +
        (ch.note ? `\nAuthor's note for this version: ${ch.note}` : "") +
        `\nLength: about ${book.chapterWords} words. ${n === book.chapters.length - 1 ? "This is the final chapter: bring the book to its end." : ""}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  };
  let level = 0;
  let user = build(0);
  while (system.length + user.length > budget && level < 4) user = build(++level);
  return [
    { role: "system", content: system.length + user.length > budget ? system.slice(0, Math.max(2000, budget - user.length)) : system },
    { role: "user", content: user },
  ];
}

export function continuePrompt(book: Book, n: number, budget: number): ChatMessage[] {
  const ch = book.chapters[n];
  const sofar = ch.text ?? "";
  const left = Math.max(300, book.chapterWords - (ch.words ?? countWords(sofar)));
  const system = writerSystem(book);
  const room = Math.max(1500, Math.min(6000, budget - system.length - 1200));
  return [
    { role: "system", content: system.slice(0, Math.max(2000, budget - room - 1200)) },
    {
      role: "user",
      content:
        `CHAPTER ${n + 1}: ${ch.title}\n${book.kind === "novel" ? "Beats" : "Covers"}: ${ch.beats}\n\n` +
        `THE CHAPTER SO FAR (it stops mid-way):\n${sofar.length > room ? "…" + sofar.slice(-room) : sofar}\n\n` +
        `Continue the chapter from exactly where it stops, with about ${left} more words that cover the beats not yet written, and bring it to the chapter's end. ` +
        `Don't repeat or summarize what's already there. Write only the new text.`,
    },
  ];
}

export function summaryPrompt(book: Book, n: number, budget: number): ChatMessage[] {
  const ch = book.chapters[n];
  let text = ch.text ?? "";
  const room = Math.max(3000, budget - 800);
  if (text.length > room) text = `${text.slice(0, room / 2)}\n…\n${text.slice(-room / 2)}`;
  const ask =
    book.kind === "novel"
      ? "Summarize this chapter for the writer of the next chapters, in at most 120 words: what happened, where each character ends up, what changed, open threads, and any facts established (names, places, objects, injuries, promises)."
      : "Summarize this chapter for the writer of the next chapters, in at most 100 words: the key points covered, terms defined and examples used, so later chapters build on them without repeating them.";
  return [
    { role: "system", content: "You write short, factual continuity notes. No commentary." },
    { role: "user", content: `CHAPTER ${n + 1}: ${ch.title}\n\n${text}\n\n${ask}` },
  ];
}

/** Cleans a model's chapter text: thinking, chatter and a repeated heading are removed. */
export function cleanChapter(text: string, title: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, "$1").trim();
  const lines = t.split("\n");
  const plainTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (let i = 0; i < 3 && lines.length; i++) {
    const l = lines[0].trim();
    const bare = l.replace(/^#{1,6}\s*|\*\*|__/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!l) lines.shift();
    else if (/^(here('s| is)|sure|certainly|okay|of course)\b.*[:.!]$/i.test(l) && l.length < 160) lines.shift();
    else if (/^#{1,6}\s/.test(l) && (/^chapter\b/.test(bare) || (plainTitle && bare.includes(plainTitle)))) lines.shift();
    else if (/^chapter\s+(\d+|[a-z]+)\b/.test(bare) && l.length < 120) lines.shift();
    else break;
  }
  t = lines.join("\n").trim();
  // Trailing chatter: "I hope this…", "(End of chapter 3)", "To be continued"
  t = t.replace(/\n+(\(?end of chapter[^\n]*\)?|to be continued\.*|---+\s*\n+(i hope|let me know|would you like)[\s\S]*)$/i, "").trim();
  return t;
}

// --- Running a step ---------------------------------------------------------------

export interface BookModel {
  /** A streamed prose call (the Writer agent's model) */
  write(messages: ChatMessage[], signal: AbortSignal, onToken: (t: string) => void): Promise<{ text: string; ref: string }>;
  /** A JSON call (for the outline) */
  json(messages: ChatMessage[]): Promise<{ json: Record<string, unknown>; ref: string }>;
  /** How many characters of prompt the model's context has room for */
  contextChars(): number;
}

/** Runs one step and applies its result to the book (the caller saves it). */
export async function runStep(book: Book, step: BookStep, model: BookModel, signal: AbortSignal, onToken: (t: string) => void = () => {}): Promise<void> {
  const budget = model.contextChars();
  switch (step.kind) {
    case "bible": {
      const out = await model.write(biblePrompt(book), signal, onToken);
      const bible = out.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (bible.length < 100) throw new Error("The model's story bible was empty or too short");
      book.bible = bible;
      return;
    }
    case "outline": {
      const out = await model.json(outlinePrompt(book));
      const parsed = parseOutline(out.json, book.chapterCount);
      if ("error" in parsed) throw new Error(parsed.error);
      book.chapters = parsed.chapters;
      book.chapterCount = parsed.chapters.length;
      if (!book.title && parsed.title) book.title = parsed.title;
      if (!book.subtitle && parsed.subtitle) book.subtitle = parsed.subtitle;
      book.stage = "review"; // you check the outline before any chapter is written
      return;
    }
    case "chapter": {
      const ch = book.chapters[step.n];
      const out = await model.write(chapterPrompt(book, step.n, budget), signal, onToken);
      const text = cleanChapter(out.text, ch.title);
      if (countWords(text) < 50) throw new Error(`Chapter ${step.n + 1} came back empty`);
      Object.assign(ch, { text, words: countWords(text), parts: 1, summary: undefined, model: out.ref });
      return;
    }
    case "continue": {
      const ch = book.chapters[step.n];
      const out = await model.write(continuePrompt(book, step.n, budget), signal, onToken);
      const more = cleanChapter(out.text, ch.title);
      ch.parts = (ch.parts ?? 1) + 1;
      // A model with nothing to add has finished the chapter
      if (countWords(more) >= 30) {
        ch.text = `${ch.text ?? ""}\n\n${more}`;
        ch.words = countWords(ch.text);
      } else ch.parts = MAX_PARTS;
      return;
    }
    case "summary": {
      const out = await model.write(summaryPrompt(book, step.n, budget), signal, onToken);
      book.chapters[step.n].summary = out.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().slice(0, 2000) || firstSentence(book.chapters[step.n].text ?? "");
      return;
    }
  }
}

/** After a step: finished books are marked done. */
export function settle(book: Book) {
  if (book.stage === "writing" && book.chapters.length && !nextStep({ ...book, paused: false })) book.stage = "done";
}

/** A failed step: tried once more, then the book pauses with the reason. */
export function failed(book: Book, message: string) {
  book.failures = (book.failures ?? 0) + 1;
  book.error = message.slice(0, 500);
  if (book.failures >= MAX_FAILURES) book.paused = true;
}

// --- Saving -----------------------------------------------------------------------

/** One JSON file per book in data/books. */
export class BookStore {
  private books = new Map<string, Book>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!/^[a-f0-9]{12}\.json$/.test(f)) continue;
      try {
        const b = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Book;
        if (BOOK_ID.test(b.id)) this.books.set(b.id, b);
      } catch {
        // A damaged file is left where it is rather than lost
      }
    }
  }

  list(project?: string | null): Book[] {
    return [...this.books.values()].filter((b) => project === undefined || b.project === project || b.project === null).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Book | undefined {
    return BOOK_ID.test(id) ? this.books.get(id) : undefined;
  }

  save(book: Book) {
    book.updatedAt = Date.now();
    this.books.set(book.id, book);
    // Written to a temporary file first, so a crash mid-write never leaves half a book
    const file = path.join(this.dir, `${book.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(book));
    renameSync(`${file}.tmp`, file);
  }

  delete(id: string): boolean {
    if (!this.books.delete(id)) return false;
    const file = path.join(this.dir, `${id}.json`);
    if (existsSync(file)) rmSync(file);
    return true;
  }

  /** The book whose step runs next: the one worked on most recently goes first, so one book is finished at a time. */
  next(): { book: Book; step: BookStep } | null {
    for (const book of [...this.books.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const step = nextStep(book);
      if (step) return { book, step };
    }
    return null;
  }
}

/** What the book list shows: everything but the text. */
export function bookSummary(book: Book) {
  const { chapters, bible, ...rest } = book;
  const words = chapters.reduce((n, c) => n + (c.words ?? 0), 0);
  return {
    ...rest,
    words,
    target: book.chapterCount * book.chapterWords,
    written: chapters.filter((c) => c.text && c.summary).length,
    chapterTotal: chapters.length,
    next: nextStep(book) ? describeStep(book, nextStep(book)!) : null,
  };
}

// --- Exports ----------------------------------------------------------------------

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "book";

export const bookFileName = (book: Book, ext: string) => `${slug(book.title || "untitled")}.${ext}`;

const written = (book: Book) => book.chapters.map((c, i) => ({ ...c, i })).filter((c) => c.text?.trim());

/** The whole manuscript as Markdown. */
export function bookMarkdown(book: Book): string {
  const head = [`# ${book.title || "Untitled"}`, book.subtitle ? `*${book.subtitle}*` : "", `by ${book.author}`].filter(Boolean).join("\n\n");
  return `${head}\n\n${written(book)
    .map((c) => `## ${book.kind === "novel" ? `Chapter ${c.i + 1}: ` : ""}${c.title}\n\n${c.text!.trim()}`)
    .join("\n\n")}\n`;
}

/** Chapter text as HTML: Markdown rendered with no pictures, *** as a scene break, headings shifted under the chapter title. */
function chapterHtml(text: string): string {
  const md = text
    .replace(/^\s*(\*\s*\*\s*\*|#\s*#\s*#|~~~|\* \* \*)\s*$/gm, "---")
    .replace(/^(#{1,5})\s/gm, (_m, h: string) => `${"#".repeat(Math.min(h.length + 1, 6))} `);
  return renderMarkdown(md, () => null).replace(/<span class="missing">[^<]*<\/span>/g, "");
}

const chapterHeading = (book: Book, i: number, title: string) =>
  `<h1>${book.kind === "novel" ? `<span class="num">Chapter ${i + 1}</span>` : ""}${xmlEsc(title)}</h1>`;

export function bookEpub(book: Book, cover?: EpubInput["cover"]): Buffer {
  return buildEpub({
    title: book.title || "Untitled",
    subtitle: book.subtitle,
    author: book.author,
    language: book.language,
    id: book.uuid,
    description: book.brief.slice(0, 1000),
    cover,
    modified: new Date(book.updatedAt),
    chapters: written(book).map((c) => ({ title: book.kind === "novel" ? `Chapter ${c.i + 1}: ${c.title}` : c.title, xhtml: toXhtml(chapterHeading(book, c.i, c.title) + chapterHtml(c.text!)) })),
  });
}

/** Trim sizes for the print PDF */
export const TRIMS = { "6x9": "6in 9in", "5x8": "5in 8in", "5.5x8.5": "5.5in 8.5in", a5: "A5", letter: "Letter" } as const;
export type Trim = keyof typeof TRIMS;

/** A print-ready HTML book (title page, contents, chapters on new pages) for printPdf. */
export function bookHtml(book: Book, opts: { trim?: Trim; cover?: string } = {}): string {
  const size = TRIMS[opts.trim ?? "6x9"] ?? TRIMS["6x9"];
  const chapters = written(book);
  const css =
    BOOK_CSS +
    `@page { size: ${size}; margin: 0.75in 0.6in 0.8in; }
     body { margin: 0; font-size: 11pt; color: #111; }
     .title-page { margin-top: 35%; page-break-after: always; break-after: page; }
     .cover-page { page-break-after: always; break-after: page; text-align: center; }
     .cover-page img { max-width: 100%; max-height: 7.2in; }
     .toc { page-break-after: always; break-after: page; }
     .toc h1 { page-break-before: auto; break-before: auto; }
     .toc ol { list-style: none; margin: 0; padding: 0; }
     .toc li { margin: 0.35em 0; }
     section.chapter { page-break-before: always; break-before: page; }
     section.chapter h1 { page-break-before: auto; break-before: auto; margin-top: 1.2in; }`;
  return (
    `<!DOCTYPE html><html lang="${xmlEsc(book.language)}"><head><meta charset="utf-8"><title>${xmlEsc(book.title || "Untitled")}</title><style>${css}</style></head><body>` +
    (opts.cover ? `<div class="cover-page"><img src="${xmlEsc(opts.cover)}" alt=""></div>` : "") +
    `<div class="title-page"><h1>${xmlEsc(book.title || "Untitled")}</h1>${book.subtitle ? `<p class="subtitle">${xmlEsc(book.subtitle)}</p>` : ""}<p class="author">${xmlEsc(book.author)}</p></div>` +
    (chapters.length > 1
      ? `<nav class="toc"><h1>Contents</h1><ol>${chapters.map((c) => `<li>${book.kind === "novel" ? `${c.i + 1}. ` : ""}${xmlEsc(c.title)}</li>`).join("")}</ol></nav>`
      : "") +
    chapters.map((c) => `<section class="chapter">${chapterHeading(book, c.i, c.title)}${chapterHtml(c.text!)}</section>`).join("") +
    `</body></html>`
  );
}
