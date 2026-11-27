// Books: novels, nonfiction ebooks, children's picture books and puzzle books, written one
// step at a time so a local model with an 8K context can still finish a whole book.
//
//   brief (+ your own source material: posts, docs, PDFs, videos, recordings)
//         → notes on each part of a large source → story bible / book plan
//         → outline (chapters, picture-book pages, or puzzles made and checked in code)
//         → waits for you to edit and approve it
//         → each chapter in order: write it (from its source passages), keep going if the
//           model stopped short, then summarize it so later chapters remember it;
//           picture-book pages get one illustration each; puzzles get their story
//         → Markdown, EPUB, print PDF, and KDP paperback files with a listing kit
//
// Every step is one model call (or one picture) through the gateway, run by the queue
// between cards, and the book is saved after each one, so a restart, a stop or a failed
// call loses at most the step that was running.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./ollama";
import { BOOK_CSS, buildEpub, toXhtml, xmlEsc } from "./epub";
import type { EpubInput } from "./epub";
import { TRIM_INCHES, interiorPageCss, listingPrompt, parseListing } from "./kdp";
import type { KdpTrim, Listing } from "./kdp";
import { renderMarkdown } from "./markdown";
import { cleanPalette } from "./kdp";
import { PUZZLE_CSS, answerHtml, clueText, answerRows, isActivity, makePuzzle, puzzleFacts, puzzleHtml, puzzleReady, puzzleSize } from "./puzzles";
import { WS_WORDS } from "./activity";
import type { Category, Difficulty, Puzzle, PuzzleType } from "./puzzles";
import { MAX_SOURCES_CHARS, chunkSources, rankChunks } from "./sources";
import type { Chunk, Source } from "./sources";

export type BookKind = "novel" | "ebook" | "picture" | "puzzle";
export type BookStage = "planning" | "review" | "writing" | "done";

export interface Chapter {
  title: string;
  /** What happens (novel), what it covers (ebook), what the picture shows (picture book), or the puzzle's setting */
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
  /** Which source parts (chunk numbers) the chapter draws on */
  sources?: number[];
  /** Picture books: the page's illustration (a saved file) */
  image?: string;
  /** Puzzle books: the puzzle, made and checked in code */
  puzzle?: Puzzle;
}

export interface ArtSettings {
  /** The art style every picture uses */
  style: string;
  /** What each character looks like, used word for word in every picture */
  characters: string;
  /** The same seed for every picture keeps the look consistent */
  seed: number;
  /** Don't make pictures (no ComfyUI, or you'll add your own) */
  off?: boolean;
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
  /** Words per chapter (per page for picture books, per story for puzzle books) */
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
  /** The cover picture is a finished cover with its own title and author (nothing is printed over it) */
  coverHasText?: boolean;
  /** Colours for the paperback's back, spine and title band (else picked from the title) */
  coverColors?: { bg: string; fg: string; accent: string };
  /** A stable id for the EPUB */
  uuid: string;
  createdAt: number;
  updatedAt: number;
  /** Your own material the book is made from */
  sources?: Source[];
  /** Notes on each part of a large source (see chunkSources) */
  digests?: string[];
  /** Stay true to the sources (repurpose) rather than use them as a starting point */
  faithful?: boolean;
  art?: ArtSettings;
  puzzle?: { type: PuzzleType; difficulty: Difficulty };
  trim?: Trim;
  listing?: Listing;
  /** A listing kit was asked for and runs next */
  wantListing?: boolean;
}

export type BookStep =
  | { kind: "digest"; n: number }
  | { kind: "bible" }
  | { kind: "outline" }
  | { kind: "chapter"; n: number }
  | { kind: "continue"; n: number }
  | { kind: "summary"; n: number }
  | { kind: "illustrate"; n: number }
  | { kind: "listing" };

export const BOOK_ID = /^[a-f0-9]{12}$/;
export const MAX_CHAPTERS = 60;
export const MAX_CHAPTER_WORDS = 8000;
/** A chapter shorter than this share of its target gets another call */
const SHORT = 0.6;
const MAX_PARTS = 3;
const MAX_FAILURES = 2;
/** Sources longer than this are read in parts and noted first */
export const SOURCE_INLINE = 12_000;
export const CHUNK_CHARS = 3500;

export const countWords = (s: string) => (s.match(/\S+/g) ?? []).length;

/** Trim sizes for print (CSS page sizes) */
export const TRIMS = Object.fromEntries(Object.entries(TRIM_INCHES).map(([k, [w, h]]) => [k, `${w}in ${h}in`])) as Record<KdpTrim, string>;
export type Trim = KdpTrim;
const DEFAULT_TRIM: Record<BookKind, Trim> = { novel: "6x9", ebook: "6x9", picture: "8.5x8.5", puzzle: "8.5x11" };
export const trimOf = (book: Book): Trim => book.trim ?? DEFAULT_TRIM[book.kind];

const KIND_DEFAULTS: Record<BookKind, { count: number; words: number; minWords: number; maxWords: number }> = {
  novel: { count: 20, words: 2500, minWords: 300, maxWords: MAX_CHAPTER_WORDS },
  ebook: { count: 10, words: 1500, minWords: 300, maxWords: MAX_CHAPTER_WORDS },
  picture: { count: 14, words: 40, minWords: 5, maxWords: 200 },
  puzzle: { count: 20, words: 250, minWords: 80, maxWords: 1500 },
};

// --- Creating and editing --------------------------------------------------------

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : dflt;
};
const hash32 = (s: string) => createHash("sha256").update(s).digest().readUInt32LE(0);

/** Checks a new book's settings. Returns the book, or what's wrong. */
export function newBook(input: Record<string, unknown>, now = Date.now()): Book | { error: string } {
  const kind: BookKind = (["novel", "ebook", "picture", "puzzle"] as const).find((k) => k === input.kind) ?? "novel";
  const brief = str(input.brief, 6000);
  if (brief.length < 10)
    return {
      error: { novel: "Describe the story you want (a sentence or two at least)", ebook: "Describe what the ebook should teach or cover", picture: "Describe the story for the picture book", puzzle: "Describe the theme of the puzzle book" }[kind],
    };
  const project = typeof input.project === "string" && input.project && input.project !== "general" ? input.project : null;
  const d = KIND_DEFAULTS[kind];
  const uuid = randomUUID();
  const book: Book = {
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
    chapterCount: int(input.chapterCount, 1, MAX_CHAPTERS, d.count),
    chapterWords: int(input.chapterWords, d.minWords, d.maxWords, d.words),
    project,
    bible: "",
    chapters: [],
    stage: "planning",
    paused: input.start === false ? true : undefined,
    uuid,
    createdAt: now,
    updatedAt: now,
  };
  if (typeof input.trim === "string" && input.trim in TRIMS) book.trim = input.trim as Trim;
  if (input.faithful !== undefined) book.faithful = input.faithful !== false;
  if (kind === "picture") book.art = { style: str(input.artStyle, 300), characters: "", seed: hash32(uuid) % 2 ** 31, off: input.pictures === false ? true : undefined };
  if (kind === "puzzle") {
    const type: PuzzleType = (["logic", "wordsearch", "sudoku"] as const).find((x) => x === input.puzzleType) ?? "mystery";
    const difficulty: Difficulty = (["easy", "medium", "hard"] as const).find((x) => x === input.difficulty) ?? "medium";
    book.puzzle = { type, difficulty };
    // A word search opens with a short themed intro; a sudoku has no words at all
    if (type === "wordsearch" && input.chapterWords === undefined) book.chapterWords = 60;
    if (type === "sudoku") book.chapterWords = 0;
  }
  return book;
}

/** Adds source material (the caller has turned it into text). Notes on the old sources are dropped. */
export function addSource(book: Book, src: Omit<Source, "id" | "addedAt">): Source | { error: string } {
  const text = src.text.replace(/\r/g, "").trim();
  if (text.length < 50) return { error: "That source had almost no text" };
  const total = (book.sources ?? []).reduce((n, s) => n + s.text.length, 0);
  if (total + text.length > MAX_SOURCES_CHARS) return { error: `A book's sources can hold at most ${(MAX_SOURCES_CHARS / 1_000_000).toFixed(0)} million characters` };
  const s: Source = { ...src, name: src.name.slice(0, 200) || "Source", text: text.slice(0, 400_000), id: randomBytes(4).toString("hex"), addedAt: Date.now() };
  book.sources = [...(book.sources ?? []), s];
  book.digests = [];
  book.faithful ??= true;
  return s;
}

export function removeSource(book: Book, id: string): boolean {
  const before = book.sources?.length ?? 0;
  book.sources = (book.sources ?? []).filter((s) => s.id !== id);
  book.digests = [];
  for (const c of book.chapters) c.sources = undefined; // part numbers no longer line up
  return book.sources.length !== before;
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
  const d = KIND_DEFAULTS[book.kind];
  if (input.chapterWords !== undefined) book.chapterWords = int(input.chapterWords, d.minWords, d.maxWords, book.chapterWords);
  if (input.cover === null || input.cover === "") book.cover = undefined;
  else if (typeof input.cover === "string") book.cover = input.cover;
  if (typeof input.coverHasText === "boolean") book.coverHasText = input.coverHasText;
  if (input.coverColors !== undefined) {
    const c = cleanPalette(input.coverColors);
    if (c === "invalid") return "Cover colours are three #rrggbb colours: background, accent, text";
    book.coverColors = c ?? undefined;
  }
  if (typeof input.faithful === "boolean") book.faithful = input.faithful;
  if (typeof input.trim === "string" && input.trim in TRIMS) book.trim = input.trim as Trim;
  if (input.art && typeof input.art === "object" && book.art) {
    const a = input.art as Record<string, unknown>;
    if (typeof a.style === "string") book.art.style = str(a.style, 300);
    if (typeof a.characters === "string") book.art.characters = str(a.characters, 2000);
    if (typeof a.off === "boolean") book.art.off = a.off || undefined;
    if (a.seed !== undefined) book.art.seed = int(a.seed, 1, 2 ** 31 - 1, book.art.seed);
  }
  if (Array.isArray(input.chapters)) {
    if (input.chapters.length > MAX_CHAPTERS) return `At most ${MAX_CHAPTERS} chapters`;
    if (!input.chapters.length) return "A book needs at least one chapter";
    const next: Chapter[] = [];
    for (const raw of input.chapters as unknown[]) {
      const c = (raw ?? {}) as Record<string, unknown>;
      // An existing chapter is referred to by its index, so moving chapters keeps their text
      const from = typeof c.from === "number" && Number.isInteger(c.from) ? book.chapters[c.from] : undefined;
      const title = str(c.title, 200) || from?.title || (book.kind === "picture" ? `Page ${next.length + 1}` : `Chapter ${next.length + 1}`);
      const beats = typeof c.beats === "string" ? str(c.beats, 3000) : (from?.beats ?? "");
      const ch: Chapter = from ? { ...from, title, beats } : { title, beats };
      // A picture book page whose scene changed gets a new picture
      if (book.kind === "picture" && from && beats !== from.beats) ch.image = undefined;
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
    if (book.stage === "done" && next.some((c, i) => stepFor(book, c, i))) book.stage = "writing";
  }
  return null;
}

/**
 * Clears part of a chapter so it's made again (with your note, if any): its text, its
 * picture (picture books) or its puzzle (puzzle books). Later chapters are kept.
 */
export function rewriteChapter(book: Book, n: number, note?: string, part: "text" | "picture" | "puzzle" = "text"): string | null {
  const ch = book.chapters[n];
  if (!ch) return "No such chapter";
  if (book.stage === "planning" || book.stage === "review") return "Approve the outline first";
  if (part === "picture") {
    if (book.kind !== "picture") return "Only picture books have pictures";
    ch.image = undefined;
  } else if (part === "puzzle") {
    if (book.kind !== "puzzle") return "Only puzzle books have puzzles";
    // A new seed gives a different puzzle with the same people and places
    if (ch.puzzle) ch.puzzle = { ...ch.puzzle, seed: (ch.puzzle.seed * 31 + 7) % 2 ** 31, clues: [], solution: [], grid: undefined, placed: undefined, givens: undefined, answer: undefined };
    ch.text = undefined;
    ch.words = undefined;
  } else {
    // Only the plan is kept: its sources, picture and puzzle, if it has them
    const keep: Chapter = { title: ch.title, beats: ch.beats };
    if (note?.trim()) keep.note = note.trim().slice(0, 1000);
    if (ch.sources) keep.sources = ch.sources;
    if (ch.image) keep.image = ch.image;
    if (ch.puzzle) keep.puzzle = ch.puzzle;
    book.chapters[n] = keep;
  }
  book.stage = "writing";
  book.paused = false;
  book.error = undefined;
  book.failures = 0;
  return null;
}

// --- What runs next ---------------------------------------------------------------

export const sourceChars = (book: Book) => (book.sources ?? []).reduce((n, s) => n + s.text.length, 0);
export const bookChunks = (book: Book): Chunk[] => (book.sources?.length ? chunkSources(book.sources, CHUNK_CHARS) : []);
const needsDigest = (book: Book) => sourceChars(book) > SOURCE_INLINE;

/** What a chapter still needs, or null when it's finished. */
function stepFor(book: Book, c: Chapter, n: number): BookStep | null {
  if (book.kind === "picture") {
    if (!c.text) return { kind: "chapter", n };
    if (!c.image && !book.art?.off) return { kind: "illustrate", n };
    return null;
  }
  // A sudoku is only its grid; every other puzzle has a story (or a word search's short intro)
  if (book.kind === "puzzle") return (!c.text && book.puzzle?.type !== "sudoku") || !puzzleReady(c.puzzle) ? { kind: "chapter", n } : null;
  if (!c.text) return { kind: "chapter", n };
  if ((c.parts ?? 1) < MAX_PARTS && (c.words ?? countWords(c.text)) < book.chapterWords * SHORT) return { kind: "continue", n };
  if (!c.summary) return { kind: "summary", n };
  return null;
}

/** The next step for a book, or null when it's waiting for you, paused or finished. */
export function nextStep(book: Book): BookStep | null {
  if (book.paused) return null;
  if (book.stage === "planning") {
    if (needsDigest(book)) {
      const count = bookChunks(book).length;
      for (let n = 0; n < count; n++) if (!book.digests?.[n]) return { kind: "digest", n };
    }
    if (!book.bible.trim()) return { kind: "bible" };
    if (!book.chapters.length) return { kind: "outline" };
    return null;
  }
  if (book.wantListing && !book.listing && book.bible) return { kind: "listing" };
  if (book.stage !== "writing") return null;
  for (let n = 0; n < book.chapters.length; n++) {
    const s = stepFor(book, book.chapters[n], n);
    if (s) return s;
  }
  return null;
}

/** "Writing chapter 3 of 20" and friends. */
export function describeStep(book: Book, step: BookStep): string {
  const unit = book.kind === "picture" ? "page" : book.kind === "puzzle" ? "puzzle" : "chapter";
  const of = "n" in step ? `${step.n + 1} of ${step.kind === "digest" ? bookChunks(book).length : book.chapters.length}` : "";
  switch (step.kind) {
    case "digest":
      return `Reading your sources (part ${of})`;
    case "bible":
      return book.kind === "novel" ? "Planning the story bible" : book.kind === "picture" ? "Creating the characters and art style" : "Planning the book";
    case "outline":
      return book.kind === "puzzle" ? "Planning and building the puzzles" : book.kind === "picture" ? "Writing the story, page by page" : "Outlining the chapters";
    case "chapter":
      return book.kind === "puzzle" ? `Writing the story for puzzle ${of}` : `Writing ${unit} ${of}`;
    case "continue":
      return `Continuing chapter ${of}`;
    case "summary":
      return `Summarizing chapter ${of}`;
    case "illustrate":
      return `Illustrating page ${of}`;
    case "listing":
      return "Writing the listing kit";
  }
}

// --- Prompts ----------------------------------------------------------------------

const label = (book: Book) => ({ novel: "novel", ebook: "nonfiction ebook", picture: "children's picture book", puzzle: `${{ logic: "logic puzzle", mystery: "murder mystery puzzle", wordsearch: "word search", sudoku: "sudoku" }[book.puzzle?.type ?? "mystery"]} book` })[book.kind];
const planName = (book: Book) => (book.kind === "novel" ? "STORY BIBLE" : book.kind === "picture" ? "CHARACTER AND STYLE SHEET" : "BOOK PLAN");

function briefBlock(book: Book): string {
  const length =
    book.kind === "picture"
      ? `Length: ${book.chapterCount} illustrated pages, about ${book.chapterWords} words of text on each`
      : book.kind === "puzzle"
        ? `Length: ${book.chapterCount} ${book.puzzle?.difficulty ?? "medium"} puzzles, ${book.puzzle?.type === "wordsearch" ? `each with a short themed intro of about ${book.chapterWords} words` : book.puzzle?.type === "sudoku" ? "one per page" : `each with a story of about ${book.chapterWords} words`}`
        : `Length: ${book.chapterCount} chapters of about ${book.chapterWords} words (${(book.chapterCount * book.chapterWords).toLocaleString("en-US")} words in all)`;
  return [
    book.title && `Working title: ${book.title}${book.subtitle ? ` — ${book.subtitle}` : ""}`,
    `Brief: ${book.brief}`,
    book.genre && `${book.kind === "novel" ? "Genre" : "Topic area"}: ${book.genre}`,
    book.audience && `Audience: ${book.audience}`,
    book.style && `Style and voice: ${book.style}`,
    length,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The sources for planning: in full when short, else the notes on each part, cut to `budget`. */
export function sourceBlock(book: Book, budget: number): string {
  if (!book.sources?.length) return "";
  if (!needsDigest(book)) {
    const full = book.sources.map((s, i) => `[Source ${i + 1}: ${s.name}]\n${s.text}`).join("\n\n");
    return `SOURCE MATERIAL (the author's own content; the book is made from it):\n${full.slice(0, budget)}`;
  }
  const chunks = bookChunks(book);
  const per = Math.max(150, Math.floor(budget / Math.max(1, chunks.length)) - 30);
  const notes = chunks.map((c, i) => `[Part ${i + 1}, from ${c.source}] ${(book.digests?.[i] ?? "").slice(0, per)}`).join("\n");
  return `SOURCE NOTES (notes on each part of the author's own content; the book is made from it):\n${notes.slice(0, budget)}`;
}

export function digestPrompt(book: Book, n: number): ChatMessage[] {
  const c = bookChunks(book)[n];
  return [
    { role: "system", content: "You take notes on source material so a book can be written from it later. Keep facts exact. No commentary." },
    {
      role: "user",
      content: `Part ${n + 1} (from "${c.source}") of the material for this book: ${book.brief}\n\n${c.text}\n\nNote what this part contains, in at most 180 words: the topic, key points, facts and figures, examples and stories, advice, and any memorable lines (quote them exactly).`,
    },
  ];
}

export function biblePrompt(book: Book, budget = 16000): ChatMessage[] {
  const sections =
    book.kind === "novel"
      ? "## Logline (one sentence)\n## Characters (3–8: name — role, what they want, their flaw, how they talk)\n## Setting (time, place, rules of the world)\n## Themes\n## Style guide (point of view, tense, tone, prose rules to follow in every chapter)\n## Arc (beginning, midpoint, climax and how it ends: plan the ending now)"
      : book.kind === "puzzle"
        ? book.puzzle?.type === "wordsearch"
          ? `## Theme (what the whole book is about)\n## Audience (age, reading level)\n## Topics (${book.chapterCount} different topics within the theme, one line each)\n## Style guide (tone of the short intros)`
          : `## Theme (the world the puzzles share)\n## Tone (cosy, gothic, comic, noir…)\n## ${book.puzzle?.type === "logic" ? "Host (who presents the puzzles, and how)" : "Detective (who investigates, how they talk)"}\n## Settings (ideas for ${book.chapterCount} different scenes, one line each)\n## Style guide (reading level, length and feel of each story)`
        : "## Reader promise (what the reader can do or understand after reading)\n## Audience (who they are, what they already know, what they struggle with)\n## Voice and style (tone, reading level, how examples and exercises are used)\n## Key terms (the words this book uses, defined once)\n## Chapter pattern (what every chapter contains, in order)\n## Arc (how the chapters build from first steps to the outcome)";
  const src = sourceBlock(book, Math.max(3000, budget - 3000));
  return [
    { role: "system", content: `You are a developmental editor planning a ${label(book)} for an author. You write clear, specific planning documents, not prose.` },
    {
      role: "user",
      content:
        `${briefBlock(book)}\n\n${src ? `${src}\n\nPlan the book around this material: its topics, order and voice.${book.faithful !== false ? " Don't add topics it doesn't cover." : ""}\n\n` : ""}` +
        `Write the ${planName(book)} in Markdown, under 700 words, with exactly these sections:\n${sections}\n\nBe concrete: real names, specific places and decisions, no placeholders. Write only the document.`,
    },
  ];
}

/** Picture books plan their characters as JSON, so every illustration can repeat their looks exactly. */
export function pictureBiblePrompt(book: Book): ChatMessage[] {
  return [
    { role: "system", content: "You plan children's picture books: warm, simple stories with a clear lesson and a character children love. Reply with JSON only." },
    {
      role: "user",
      content:
        `${briefBlock(book)}\n\nPlan the book as {"title": "…", "logline": "one sentence", "lesson": "what the child takes away", ` +
        `"characters": [{"name": "…", "look": "one sentence an illustrator can repeat exactly: species or age, colours, clothes, one distinctive detail"}], ` +
        `"style": "one line describing the art style${book.art?.style ? ` (the author wants: ${book.art.style})` : ", e.g. soft watercolour, warm pastel colours, gentle lines"}"}. 1–4 characters.`,
    },
  ];
}

export function outlinePrompt(book: Book, budget = 16000): ChatMessage[] {
  if (book.kind === "picture") {
    return [
      { role: "system", content: "You write children's picture books page by page. Reply with JSON only." },
      {
        role: "user",
        content:
          `${briefBlock(book)}\n\nCHARACTER AND STYLE SHEET:\n${book.bible}\n\n` +
          `Write the whole story as exactly ${book.chapterCount} pages. For each page give "text": what's printed on the page (at most ${book.chapterWords} words, simple words, read-aloud rhythm${book.audience ? `, for ${book.audience}` : ""}) ` +
          `and "picture": what the illustration shows (who, doing what, where, their expression), without describing any writing in the picture. The last page lands the lesson warmly.\n` +
          `Reply as {"title": "…", "pages": [{"text": "…", "picture": "…"}]}`,
      },
    ];
  }
  if (book.kind === "puzzle") {
    const { n } = puzzleSize(book.puzzle?.type ?? "mystery", book.puzzle?.difficulty ?? "medium");
    const shape =
      book.puzzle?.type === "wordsearch"
        ? `{"title": "the book's title", "puzzles": [{"title": "the topic", "theme": "one sentence", "words": [${WS_WORDS[book.puzzle.difficulty]} single words or short names on the topic, letters only, at most ${{ easy: 12, medium: 15, hard: 17 }[book.puzzle.difficulty]} letters each]}]}`
        : book.puzzle?.type === "logic"
        ? `{"title": "the book's title", "puzzles": [{"title": "…", "scenario": "one sentence", "people": [${n} first names], "categories": [{"name": "e.g. Pet", "verb": "e.g. owns", "items": [${n} items]}, {"name": "…", "verb": "…", "items": [${n} items]}]}]}`
        : `{"title": "the book's title", "puzzles": [{"title": "…", "setting": "one sentence", "victim": "name and who they were", "suspects": [{"name": "…", "role": "a few words"}] (exactly ${n}), "places": [${n} rooms or places, each starting with "the"], "items": [${n} possible weapons, each starting with "the"]}]}`;
    return [
      { role: "system", content: "You design themed puzzle books. Reply with JSON only." },
      {
        role: "user",
        content: `${briefBlock(book)}\n\nBOOK PLAN:\n${book.bible}\n\nDesign exactly ${book.chapterCount} puzzles, each in a different scene from the plan, with all names in a puzzle different. Reply as ${shape}`,
      },
    ];
  }
  const what = book.kind === "novel" ? "what happens: the scenes, who is in them, what changes, and the hook that leads into the next chapter" : "what it teaches: the key points in order, one example or exercise, and what the reader can do afterwards";
  const src = sourceBlock(book, Math.max(2500, budget - 4000));
  const parts = needsDigest(book) ? bookChunks(book).length : 0;
  return [
    { role: "system", content: `You plan ${label(book)}s chapter by chapter. Reply with JSON only.` },
    {
      role: "user",
      content:
        `${briefBlock(book)}\n\n${planName(book)}:\n${book.bible}\n\n${src ? `${src}\n\n` : ""}` +
        `Plan exactly ${book.chapterCount} chapters that follow the ${book.kind === "novel" ? "arc" : "plan"} above from start to finish. ` +
        `For each chapter give a title and "beats": 3–5 sentences on ${what}.` +
        (parts ? ` Also give "sources": the numbers of the source parts (1–${parts}) the chapter draws on.` : "") +
        `\nReply as {"title": "the book's title", "subtitle": "optional", "chapters": [{"title": "…", "beats": "…"${parts ? ', "sources": [1, 2]' : ""}}]}`,
    },
  ];
}

/** Parses the outline reply. Returns the chapters, or why it can't be used. */
export function parseOutline(json: Record<string, unknown>, want: number, parts = 0): { title?: string; subtitle?: string; chapters: Chapter[] } | { error: string } {
  const list = Array.isArray(json.chapters) ? json.chapters : Array.isArray(json.outline) ? json.outline : null;
  if (!list?.length) return { error: "The outline had no chapters" };
  const chapters: Chapter[] = [];
  for (const raw of list.slice(0, MAX_CHAPTERS)) {
    const c = (typeof raw === "string" ? { title: raw } : (raw ?? {})) as Record<string, unknown>;
    const beats = Array.isArray(c.beats) ? c.beats.map(String).join(" ") : str(c.beats ?? c.summary ?? c.description ?? c.points, 3000);
    const title = str(c.title ?? c.name, 200).replace(/^(chapter\s+\d+\s*[:.\-–—]\s*)/i, "");
    if (!title && !beats) continue;
    const ch: Chapter = { title: title || `Chapter ${chapters.length + 1}`, beats };
    if (parts && Array.isArray(c.sources)) {
      const nums = [...new Set(c.sources.map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= parts))].slice(0, 8);
      if (nums.length) ch.sources = nums.map((x) => x - 1);
    }
    chapters.push(ch);
  }
  if (!chapters.length) return { error: "The outline had no usable chapters" };
  // A model that planned too few is taken at its word; too many are cut to the length asked for
  return { title: str(json.title, 200) || undefined, subtitle: str(json.subtitle, 200) || undefined, chapters: chapters.slice(0, Math.max(want, 1)) };
}

/** Parses a picture book's pages. */
export function parsePages(json: Record<string, unknown>, want: number): { title?: string; chapters: Chapter[] } | { error: string } {
  const list = Array.isArray(json.pages) ? json.pages : null;
  if (!list?.length) return { error: "The story had no pages" };
  const chapters = list
    .slice(0, Math.max(want, 1))
    .map((raw) => (raw ?? {}) as Record<string, unknown>)
    .map((p, i): Chapter => {
      const text = str(p.text, 1500);
      return { title: `Page ${i + 1}`, beats: str(p.picture ?? p.illustration ?? p.scene, 1500), text: text || undefined, words: text ? countWords(text) : undefined };
    })
    .filter((c) => c.text || c.beats);
  if (!chapters.length) return { error: "The story had no usable pages" };
  return { title: str(json.title, 200) || undefined, chapters };
}

/** Turns the model's puzzle designs into categories (the puzzle maker fills any gaps). */
function puzzleCategories(book: Book, p: Record<string, unknown>): { cats: Category[]; victim?: string; roles?: string[] } {
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? String((x as Record<string, unknown>).name ?? "") : "")).map((x) => x.trim().slice(0, 40)).filter(Boolean) : []);
  if (book.puzzle?.type === "logic") {
    const cats: Category[] = [{ name: "Person", items: list(p.people) }];
    for (const c of Array.isArray(p.categories) ? (p.categories as Record<string, unknown>[]) : []) {
      if (c && typeof c === "object") cats.push({ name: str(c.name, 30) || "Item", verb: str(c.verb, 30) || "has", items: list(c.items) });
    }
    return { cats };
  }
  const suspects = Array.isArray(p.suspects) ? (p.suspects as unknown[]) : [];
  return {
    cats: [
      { name: "Suspect", items: list(suspects) },
      { name: "Place", verb: "was in", items: list(p.places) },
      { name: "Item", verb: "had", items: list(p.items) },
    ],
    victim: str(p.victim, 120) || undefined,
    roles: suspects.map((s) => (s && typeof s === "object" ? str((s as Record<string, unknown>).role, 80) : "")),
  };
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
      : book.kind === "picture"
        ? ["You write the text of children's picture books: simple, warm, rhythmic sentences that read aloud well.", "Write only the page's text: no labels, no picture descriptions."]
        : book.kind === "puzzle"
          ? [
              ...(book.puzzle?.type === "wordsearch"
                ? [
                    "You write the short, friendly introduction above each word search in a puzzle book: a fun fact or two about the topic.",
                    "Write only the introduction in plain text: no heading, no word list, no grid (those are added for you).",
                  ]
                : [
                    "You write the short story that opens each puzzle in a puzzle book.",
                    "Write only the story in Markdown: no heading, no clues list, no solution, no grid (those are added for you).",
                    "Introduce the setting and every person named, in character. Don't state or hint at who did what: the reader works that out from the clues that follow.",
                    "End by inviting the reader to solve it.",
                  ]),
            ]
          : [
              "You are an expert nonfiction author writing one chapter of an ebook at a time.",
              "Write only the chapter in Markdown: no chapter heading (it's added for you); use ## and ### subheadings, short paragraphs, lists and the occasional table.",
              "Be practical and specific: concrete examples, steps the reader can follow, and a short recap at the end.",
              "Don't invent statistics, studies, quotes or sources. When something needs evidence, say so in general terms rather than making up numbers.",
              "Follow the book plan's voice and chapter pattern, and don't repeat what earlier chapters already covered.",
            ];
  if (book.sources?.length) {
    rules.push(
      book.faithful !== false
        ? "This book is made from the author's own content. Base the chapter on the SOURCE MATERIAL given: keep its facts, examples, advice and the author's voice, and reorganize and smooth it into book form. Don't add facts, numbers, stories or claims that aren't in it."
        : "Use the SOURCE MATERIAL given as your main reference. You may expand on it, but never contradict it.",
    );
  }
  return `${rules.join("\n")}\n\n${planName(book)} — ${book.title || "untitled"}:\n${book.bible}`;
}

const firstSentence = (s: string) => (/^.+?[.!?](\s|$)/.exec(s.replace(/\s+/g, " ").trim())?.[0] ?? s).trim().slice(0, 200);

/** The source passages for a chapter: the parts the outline named, else the best matches, cut to `budget`. */
export function chapterSources(book: Book, n: number, budget: number): string {
  const chunks = bookChunks(book);
  if (!chunks.length || budget < 500) return "";
  const ch = book.chapters[n];
  let picked = (ch.sources ?? []).map((i) => chunks[i]).filter(Boolean);
  if (!picked.length) picked = rankChunks(chunks, `${ch.title} ${ch.beats}`, budget);
  // Only one short source: all of it
  if (!picked.length && sourceChars(book) <= budget) picked = chunks;
  let used = 0;
  const parts: string[] = [];
  for (const c of picked) {
    const room = budget - used;
    if (room < 300) break;
    const text = c.text.length > room ? `${c.text.slice(0, room - 1)}…` : c.text;
    parts.push(`[from ${c.source}]\n${text}`);
    used += text.length + c.source.length + 10;
  }
  return parts.length ? `SOURCE MATERIAL FOR THIS CHAPTER:\n${parts.join("\n\n")}` : "";
}

/**
 * What the writer sees for chapter n, shrunk to fit `budget` characters: the source
 * passages, the outline (far chapters by title only), the story so far (older chapters
 * cut to a sentence, then dropped), and the end of the previous chapter.
 */
export function chapterPrompt(book: Book, n: number, budget: number): ChatMessage[] {
  const system = writerSystem(book);
  const ch = book.chapters[n];
  if (book.kind === "picture") {
    const prev = n > 0 ? book.chapters[n - 1].text ?? "" : "";
    const next = book.chapters[n + 1]?.text ?? "";
    return [
      { role: "system", content: system },
      {
        role: "user",
        content: `${prev ? `PREVIOUS PAGE: ${prev}\n` : ""}${next ? `NEXT PAGE: ${next}\n` : ""}\nWrite the text for page ${n + 1} of ${book.chapters.length}. The picture shows: ${ch.beats}\nAt most ${book.chapterWords} words.${ch.note ? ` Author's note: ${ch.note}` : ""}`,
      },
    ];
  }
  if (book.kind === "puzzle") {
    return [
      { role: "system", content: system },
      {
        role: "user",
        content:
          `PUZZLE ${n + 1}: ${ch.title}\n${book.puzzle?.type === "wordsearch" ? "Topic" : "Scene"}: ${ch.beats}\n${ch.puzzle ? puzzleFacts(ch.puzzle) : ""}\n\n` +
          (book.puzzle?.type === "wordsearch"
            ? `Write the introduction, about ${book.chapterWords} words.`
            : `Write the story that sets up this puzzle, about ${book.chapterWords} words.`) +
          (ch.note ? ` Author's note: ${ch.note}` : ""),
      },
    ];
  }
  const src = chapterSources(book, n, Math.floor(budget * 0.4));
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
      src,
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

/** The prompt for one picture-book illustration: the style and the characters' looks, word for word, then the scene. */
export function illustrationPrompt(book: Book, n: number): string {
  const art = book.art ?? { style: "", characters: "", seed: 1 };
  const scene = book.chapters[n].beats || book.chapters[n].text || "";
  return [art.style || "Children's picture book illustration, soft watercolour, warm colours", art.characters, `Scene: ${scene}`, "Children's book illustration. No text, no letters, no words in the picture."]
    .filter(Boolean)
    .join(". ")
    .replace(/\.\s*\./g, ".")
    .slice(0, 1500);
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
    else if (/^#{1,6}\s/.test(l) && (/^(chapter|page|puzzle)\b/.test(bare) || (plainTitle && bare.includes(plainTitle)))) lines.shift();
    else if (/^(chapter|page)\s+(\d+|[a-z]+)\b/.test(bare) && l.length < 120) lines.shift();
    else break;
  }
  t = lines.join("\n").trim();
  // Trailing chatter: "I hope this…", "(End of chapter 3)", "To be continued"
  t = t.replace(/\n+(\(?end of chapter[^\n]*\)?|to be continued\.*|---+\s*\n+(i hope|let me know|would you like)[\s\S]*)$/i, "").trim();
  return t;
}

// --- Running a step ---------------------------------------------------------------

export type PictureSize = "square" | "portrait" | "landscape";

export interface BookModel {
  /** A streamed prose call (the Writer agent's model) */
  write(messages: ChatMessage[], signal: AbortSignal, onToken: (t: string) => void): Promise<{ text: string; ref: string }>;
  /** A JSON call (outlines, picture-book plans, listings) */
  json(messages: ChatMessage[]): Promise<{ json: Record<string, unknown>; ref: string }>;
  /** How many characters of prompt the model's context has room for */
  contextChars(): number;
  /** Makes one illustration and saves it; returns the saved file's name */
  illustrate?(prompt: string, seed: number, size: PictureSize, signal: AbortSignal): Promise<{ name: string; ref?: string }>;
}

const pictureSize = (book: Book): PictureSize => {
  const [w, h] = TRIM_INCHES[trimOf(book)];
  return Math.abs(w - h) < 0.3 ? "square" : w > h ? "landscape" : "portrait";
};

/** Runs one step and applies its result to the book (the caller saves it). */
export async function runStep(book: Book, step: BookStep, model: BookModel, signal: AbortSignal, onToken: (t: string) => void = () => {}): Promise<void> {
  const budget = model.contextChars();
  switch (step.kind) {
    case "digest": {
      const out = await model.write(digestPrompt(book, step.n), signal, onToken);
      const note = out.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      book.digests = [...(book.digests ?? [])];
      book.digests[step.n] = note.slice(0, 2000) || bookChunks(book)[step.n].text.slice(0, 600);
      return;
    }
    case "bible": {
      if (book.kind === "puzzle" && book.puzzle?.type === "sudoku") {
        // Nothing for a model to plan: the grids are made in code
        book.bible = `## Sudoku\n${book.chapterCount} ${book.puzzle.difficulty} sudoku puzzles, one per page, with the answers at the back.\n\n## Brief\n${book.brief}`;
        return;
      }
      if (book.kind === "picture") {
        const out = await model.json(pictureBiblePrompt(book));
        const j = out.json;
        const chars = (Array.isArray(j.characters) ? j.characters : [])
          .map((c) => (c ?? {}) as Record<string, unknown>)
          .map((c) => ({ name: str(c.name, 60), look: str(c.look, 400) }))
          .filter((c) => c.name && c.look);
        if (!chars.length) throw new Error("The model's plan had no characters");
        const styleLine = str(j.style, 300) || book.art?.style || "soft watercolour children's book illustration, warm colours";
        book.art = { ...(book.art ?? { seed: hash32(book.uuid) % 2 ** 31 }), style: book.art?.style || styleLine, characters: chars.map((c) => `${c.name}: ${c.look}`).join(" ") } as ArtSettings;
        if (!book.title && str(j.title, 200)) book.title = str(j.title, 200);
        book.bible = [`## Story\n${str(j.logline, 600)}`, `## Lesson\n${str(j.lesson, 400)}`, `## Characters\n${chars.map((c) => `- **${c.name}** — ${c.look}`).join("\n")}`, `## Art style\n${book.art.style}`].join("\n\n");
        return;
      }
      const out = await model.write(biblePrompt(book, budget), signal, onToken);
      const bible = out.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (bible.length < 100) throw new Error("The model's plan was empty or too short");
      book.bible = bible;
      return;
    }
    case "outline": {
      if (book.kind === "puzzle" && book.puzzle?.type === "sudoku") {
        book.chapters = Array.from({ length: book.chapterCount }, (_, i) => ({ title: `Sudoku ${i + 1}`, beats: "" }));
        book.stage = "review";
        return;
      }
      const out = await model.json(outlinePrompt(book, budget));
      if (book.kind === "picture") {
        const parsed = parsePages(out.json, book.chapterCount);
        if ("error" in parsed) throw new Error(parsed.error);
        book.chapters = parsed.chapters;
        if (!book.title && parsed.title) book.title = parsed.title;
      } else if (book.kind === "puzzle") {
        const list = (Array.isArray(out.json.puzzles) ? out.json.puzzles : []).slice(0, book.chapterCount) as Record<string, unknown>[];
        if (!list.length) throw new Error("The model designed no puzzles");
        const chapters: Chapter[] = [];
        for (const [i, p] of list.entries()) {
          const seed = hash32(`${book.uuid}:${i}`) % 2 ** 31;
          if (book.puzzle!.type === "wordsearch") {
            const words = Array.isArray(p?.words) ? p.words : [];
            let puzzle;
            try {
              puzzle = await makePuzzle("wordsearch", book.puzzle!.difficulty, [], seed, { words });
            } catch {
              continue; // too few usable words: the outline keeps the others
            }
            chapters.push({ title: str(p?.title, 200) || `Word search ${i + 1}`, beats: str(p?.theme, 600), puzzle });
            continue;
          }
          const { cats, victim, roles } = puzzleCategories(book, p ?? {});
          const puzzle = await makePuzzle(book.puzzle!.type, book.puzzle!.difficulty, cats, seed, { victim, roles });
          chapters.push({ title: str(p?.title, 200) || `Puzzle ${i + 1}`, beats: str(p?.setting ?? p?.scenario, 600), puzzle });
        }
        if (!chapters.length) throw new Error("The model's puzzles had too few usable words");
        book.chapters = chapters;
        if (!book.title && str(out.json.title, 200)) book.title = str(out.json.title, 200);
      } else {
        const parsed = parseOutline(out.json, book.chapterCount, needsDigest(book) ? bookChunks(book).length : 0);
        if ("error" in parsed) throw new Error(parsed.error);
        book.chapters = parsed.chapters;
        if (!book.title && parsed.title) book.title = parsed.title;
        if (!book.subtitle && parsed.subtitle) book.subtitle = parsed.subtitle;
      }
      book.chapterCount = book.chapters.length;
      book.stage = "review"; // you check the outline before anything is written
      return;
    }
    case "chapter": {
      const ch = book.chapters[step.n];
      // A puzzle added by hand, or one asked to be made again, is made before its story
      if (book.kind === "puzzle" && !puzzleReady(ch.puzzle)) {
        const old = ch.puzzle;
        ch.puzzle = await makePuzzle(book.puzzle!.type, book.puzzle!.difficulty, old?.categories ?? [], old?.seed ?? hash32(`${book.uuid}:${step.n}:${Date.now()}`) % 2 ** 31, {
          victim: old?.crime?.victim,
          roles: old?.roles,
          words: old?.words,
        });
      }
      if (book.kind === "puzzle" && book.puzzle?.type === "sudoku") {
        Object.assign(ch, { text: ch.text ?? "", words: 0, parts: 1 });
        return;
      }
      const out = await model.write(chapterPrompt(book, step.n, budget), signal, onToken);
      const text = cleanChapter(out.text, ch.title);
      const min = book.kind === "picture" ? 1 : book.kind === "puzzle" ? (book.puzzle?.type === "wordsearch" ? 8 : 20) : 50;
      if (countWords(text) < min) throw new Error(`${book.kind === "picture" ? "Page" : book.kind === "puzzle" ? "The story for puzzle" : "Chapter"} ${step.n + 1} came back empty`);
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
    case "illustrate": {
      if (!model.illustrate) throw new Error("Pictures need the tools service with ComfyUI (TOOLS_URL and the images server). Turn pictures off for this book to finish without them.");
      const out = await model.illustrate(illustrationPrompt(book, step.n), book.art?.seed ?? 1, pictureSize(book), signal);
      book.chapters[step.n].image = out.name;
      return;
    }
    case "listing": {
      const out = await model.json(listingPrompt(book));
      const listing = parseListing(out.json);
      if ("error" in listing) throw new Error(listing.error);
      book.listing = listing;
      book.wantListing = undefined;
      return;
    }
  }
}

/** After a step: finished books are marked done. */
export function settle(book: Book) {
  if (book.stage === "writing" && book.chapters.length && !book.chapters.some((c, i) => stepFor(book, c, i))) book.stage = "done";
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
  const { chapters, bible, sources, digests, ...rest } = book;
  const words = chapters.reduce((n, c) => n + (c.words ?? 0), 0);
  const step = nextStep(book);
  return {
    ...rest,
    words,
    target: book.chapterCount * book.chapterWords,
    written: chapters.filter((c, i) => (c.text || (c.puzzle && puzzleReady(c.puzzle))) && !stepFor(book, c, i)).length,
    chapterTotal: chapters.length,
    sourceCount: sources?.length ?? 0,
    next: step ? describeStep(book, step) : null,
  };
}

/** A book as the Books page sees it: sources without their full text. */
export function bookDetail(book: Book) {
  const chunks = bookChunks(book).length;
  return {
    ...book,
    // Puzzles as the page shows them: the clues in words, and the answer
    chapters: book.chapters.map(({ puzzle, ...c }) =>
      puzzle && puzzleReady(puzzle)
        ? {
            ...c,
            puzzleView: {
              ...(puzzle.type === "wordsearch" ? { grid: puzzle.grid, words: puzzle.words } : puzzle.type === "sudoku" ? { givens: puzzle.givens } : {}),
              categories: puzzle.categories.map((x) => `${x.name}: ${x.items.join(", ")}`),
              clues: puzzle.clues.map((cl) => clueText(puzzle, cl)),
              crime: puzzle.crime ? `${puzzle.crime.victim} was found in ${puzzle.categories[1].items[puzzle.crime.place]}, killed with ${puzzle.categories[2].items[puzzle.crime.item]}.` : undefined,
              answer: puzzle.crime ? `${puzzle.categories[0].items[puzzle.crime.culprit]} did it.` : undefined,
              rows: answerRows(puzzle),
              difficulty: puzzle.difficulty,
            },
          }
        : c,
    ),
    sources: (book.sources ?? []).map(({ text, ...s }) => ({ ...s, chars: text.length, preview: text.slice(0, 300) })),
    digests: undefined,
    sourceParts: chunks,
    digested: (book.digests ?? []).filter(Boolean).length,
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

const written = (book: Book) => book.chapters.map((c, i) => ({ ...c, i })).filter((c) => c.text?.trim() || c.image || (c.puzzle && puzzleReady(c.puzzle)));
/** Whether any part of a book is made yet (text, a picture, or a puzzle) */
export const hasContent = (book: Book) => written(book).length > 0;
const unitLabel = (book: Book, i: number, title: string) => (book.kind === "novel" ? `Chapter ${i + 1}: ${title}` : book.kind === "puzzle" ? `${i + 1}. ${title}` : title);

/** The whole manuscript as Markdown. */
const sudokuText = (cells: number[]) =>
  Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (_, c) => cells[r * 9 + c] || ".").join(" ").replace(/(\S \S \S) /g, "$1 | ").replace(/ \| $/, "")).map((l, r) => (r % 3 === 2 && r < 8 ? `${l}\n------+-------+------` : l)).join("\n");
const dirName = (dr: number, dc: number) => ({ "0,1": "across", "1,0": "down", "1,1": "down-right", "-1,1": "up-right", "0,-1": "backwards", "-1,0": "up", "-1,-1": "up-left", "1,-1": "down-left" } as Record<string, string>)[`${dr},${dc}`] ?? "";

export function bookMarkdown(book: Book): string {
  const head = [`# ${book.title || "Untitled"}`, book.subtitle ? `*${book.subtitle}*` : "", `by ${book.author}`].filter(Boolean).join("\n\n");
  const body = written(book).map((c) => {
    if (book.kind === "picture") return `## Page ${c.i + 1}\n\n${c.text ?? ""}\n\n*[Picture: ${c.beats}]*`;
    let md = `## ${unitLabel(book, c.i, c.title)}\n\n${(c.text ?? "").trim()}`;
    if (c.puzzle && puzzleReady(c.puzzle) && isActivity(c.puzzle.type)) {
      const p = c.puzzle;
      md += p.type === "wordsearch" ? `\n\n\`\`\`\n${(p.grid ?? []).map((r) => [...r].join(" ")).join("\n")}\n\`\`\`\n\nFind: ${(p.words ?? []).join(", ")}` : `\n\n\`\`\`\n${sudokuText(p.givens ?? [])}\n\`\`\``;
    } else if (c.puzzle && puzzleReady(c.puzzle)) {
      const p = c.puzzle;
      md += `\n\n${puzzleFacts(p)
        .split("\n")
        .filter((l) => !l.startsWith("Who they are"))
        .map((l) => `- ${l}`)
        .join("\n")}\n\n### Clues\n\n${p.clues.map((cl, j) => `${j + 1}. ${clueText(p, cl)}`).join("\n")}`;
    }
    return md;
  });
  let md = `${head}\n\n${body.join("\n\n")}\n`;
  const answers = written(book).filter((c) => puzzleReady(c.puzzle));
  if (answers.length) {
    md += `\n## Answer key\n\n${answers
      .map((c) => {
        const p = c.puzzle!;
        if (p.type === "sudoku") return `### ${c.i + 1}. ${c.title}\n\n\`\`\`\n${sudokuText(p.answer ?? [])}\n\`\`\``;
        if (p.type === "wordsearch") return `### ${c.i + 1}. ${c.title}\n\n${(p.placed ?? []).map((w) => `- ${w.word}: row ${w.r + 1}, column ${w.c + 1}, ${dirName(w.dr, w.dc)}`).join("\n")}`;
        const rows = answerRows(p);
        return `### ${c.i + 1}. ${c.title}\n\n${p.crime ? `**${p.categories[0].items[p.crime.culprit]} did it.**\n\n` : ""}| ${p.categories.map((x) => x.name).join(" | ")} |\n| ${p.categories.map(() => "---").join(" | ")} |\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}`;
      })
      .join("\n\n")}\n`;
  }
  return md;
}

/** Chapter text as HTML: Markdown rendered with no pictures, *** as a scene break, headings shifted under the chapter title. */
function chapterHtml(text: string): string {
  const md = text
    .replace(/^\s*(\*\s*\*\s*\*|#\s*#\s*#|~~~|\* \* \*)\s*$/gm, "---")
    .replace(/^(#{1,5})\s/gm, (_m, h: string) => `${"#".repeat(Math.min(h.length + 1, 6))} `);
  return renderMarkdown(md, () => null).replace(/<span class="missing">[^<]*<\/span>/g, "");
}

const chapterHeading = (book: Book, i: number, title: string) =>
  `<h1>${book.kind === "novel" ? `<span class="num">Chapter ${i + 1}</span>` : book.kind === "puzzle" ? `<span class="num">Puzzle ${i + 1}</span>` : ""}${xmlEsc(title)}</h1>`;

/** Reads a saved illustration: its bytes and type. */
export type ImageLoader = (name: string) => { data: Buffer; mime: "image/png" | "image/jpeg" | "image/webp" } | null;

export function bookEpub(book: Book, cover?: EpubInput["cover"], loadImage: ImageLoader = () => null): Buffer {
  const images: NonNullable<EpubInput["images"]> = [];
  const chapters = written(book).map((c) => {
    let body = chapterHeading(book, c.i, book.kind === "picture" ? `Page ${c.i + 1}` : c.title);
    if (book.kind === "picture") {
      const img = c.image ? loadImage(c.image) : null;
      if (img) {
        const name = `page-${c.i + 1}.${img.mime === "image/jpeg" ? "jpg" : img.mime === "image/webp" ? "webp" : "png"}`;
        images.push({ name, data: img.data, mime: img.mime });
        body = `<div class="picture-page"><img src="images/${name}" alt="${xmlEsc(c.beats.slice(0, 200))}"/></div>`;
      } else body = "";
      body += `<p class="page-text">${xmlEsc(c.text ?? "")}</p>`;
    } else {
      body += chapterHtml(c.text ?? "");
      if (c.puzzle && puzzleReady(c.puzzle)) body += puzzleHtml(c.puzzle);
    }
    return { title: book.kind === "picture" ? `Page ${c.i + 1}` : unitLabel(book, c.i, c.title), xhtml: toXhtml(body) };
  });
  const answers = written(book).filter((c) => puzzleReady(c.puzzle));
  if (answers.length) chapters.push({ title: "Answer key", xhtml: toXhtml(`<h1>Answer key</h1>${answers.map((c) => answerHtml(c.puzzle!, c.title, c.i + 1)).join("")}`) });
  return buildEpub({
    title: book.title || "Untitled",
    subtitle: book.subtitle,
    author: book.author,
    language: book.language,
    id: book.uuid,
    description: (book.listing?.backCover || book.brief).slice(0, 1000),
    cover,
    modified: new Date(book.updatedAt),
    chapters,
    images,
    extraCss: (book.kind === "puzzle" ? PUZZLE_CSS : "") + (book.kind === "picture" ? ".picture-page { text-align: center; margin: 0 0 1em; } .picture-page img { max-width: 100%; } p.page-text { text-indent: 0; text-align: center; font-size: 1.3em; line-height: 1.5; }" : ""),
  });
}

export interface PrintOptions {
  trim?: Trim;
  /** A data: URI for a cover page (left out of KDP interiors: the cover is its own file) */
  cover?: string;
  /** KDP interior: mirrored margins for this page count, bleed for picture books, padding to KDP's minimum */
  kdp?: { pages: number; padTo?: number };
  /** Illustrations as data: URIs */
  image?: (name: string) => string | null;
}

/** A print-ready HTML book for printPdf: title page, contents, chapters on new pages. */
export function bookHtml(book: Book, opts: PrintOptions = {}): string {
  const trim = opts.trim && opts.trim in TRIMS ? opts.trim : trimOf(book);
  const [w, h] = TRIM_INCHES[trim];
  const chapters = written(book);
  const picture = book.kind === "picture";
  const page = opts.kdp ? interiorPageCss(trim, opts.kdp.pages, { bleed: picture }) : picture ? `@page { size: ${TRIMS[trim]}; margin: 0; }` : `@page { size: ${TRIMS[trim]}; margin: 0.75in 0.6in 0.8in; }`;
  // A bleed page is 0.125 in wider (outside edge) and 0.25 in taller
  const pw = picture && opts.kdp ? w + 0.125 : w;
  const ph = picture && opts.kdp ? h + 0.25 : h;
  const css =
    BOOK_CSS +
    (book.kind === "puzzle" ? PUZZLE_CSS : "") +
    page +
    `body { margin: 0; font-size: ${book.kind === "puzzle" ? 11.5 : 11}pt; color: #111; }
     .title-page { margin-top: 35%; page-break-after: always; break-after: page; }
     .cover-page { page-break-after: always; break-after: page; text-align: center; }
     .cover-page img { max-width: 100%; max-height: ${h - 1.8}in; }
     .toc { page-break-after: always; break-after: page; }
     .toc h1 { page-break-before: auto; break-before: auto; }
     .toc ol { list-style: none; margin: 0; padding: 0; }
     .toc li { margin: 0.35em 0; }
     section.chapter { page-break-before: always; break-before: page; }
     section.chapter h1 { page-break-before: auto; break-before: auto; margin-top: ${book.kind === "puzzle" ? 0.3 : 1.2}in; }
     .blank { page-break-before: always; break-before: page; height: 1px; }
     .belongs { page-break-before: always; break-before: page; text-align: center; padding-top: 35%; font-size: 20pt; }
     .belongs .line { border-bottom: 1px solid #555; width: 60%; margin: 0.6in auto 0; }
     .pp { box-sizing: border-box; width: ${pw}in; height: ${ph}in; position: relative; overflow: hidden; page-break-after: always; break-after: page; }
     .pp img { position: absolute; left: 0; top: 0; width: 100%; height: 72%; object-fit: cover; }
     .pp .noimg { position: absolute; left: 0; top: 0; width: 100%; height: 72%; background: #f1ece2; }
     .pp .txt { position: absolute; left: 0.5in; right: 0.5in; top: 74%; bottom: 0.5in; display: flex; align-items: center; justify-content: center; text-align: center; font-size: ${w >= 8 ? 20 : 16}pt; line-height: 1.45; font-family: Georgia, serif; }
     .pp.title { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 0.75in; }
     .pp.title h1 { page-break-before: auto; break-before: auto; font-size: 30pt; margin: 0 0 0.3in; }
     .pp.title .author { font-size: 16pt; }`;
  const head = `<!DOCTYPE html><html lang="${xmlEsc(book.language)}"><head><meta charset="utf-8"><title>${xmlEsc(book.title || "Untitled")}</title><style>${css}</style></head><body>`;
  const coverPage = opts.cover && !opts.kdp ? (picture ? `<div class="pp"><img src="${xmlEsc(opts.cover)}" alt="" style="height:100%"></div>` : `<div class="cover-page"><img src="${xmlEsc(opts.cover)}" alt=""></div>`) : "";
  const pad = Math.max(0, (opts.kdp?.padTo ?? 0) - (opts.kdp?.pages ?? 0));

  if (picture) {
    const pages = chapters.map((c) => {
      const src = c.image ? opts.image?.(c.image) : null;
      return `<div class="pp">${src ? `<img src="${xmlEsc(src)}" alt="">` : `<div class="noimg"></div>`}<div class="txt">${xmlEsc(c.text ?? "")}</div></div>`;
    });
    const belongs = pad > 0 ? `<div class="belongs">This book belongs to<div class="line"></div></div>` : "";
    return (
      head +
      coverPage +
      `<div class="pp title"><h1>${xmlEsc(book.title || "Untitled")}</h1>${book.subtitle ? `<p class="subtitle">${xmlEsc(book.subtitle)}</p>` : ""}<p class="author">${xmlEsc(book.author)}</p></div>` +
      pages.join("") +
      belongs +
      `<div class="blank"></div>`.repeat(Math.max(0, pad - (belongs ? 1 : 0))) +
      `</body></html>`
    );
  }

  const answers = chapters.filter((c) => puzzleReady(c.puzzle));
  return (
    head +
    coverPage +
    `<div class="title-page"><h1>${xmlEsc(book.title || "Untitled")}</h1>${book.subtitle ? `<p class="subtitle">${xmlEsc(book.subtitle)}</p>` : ""}<p class="author">${xmlEsc(book.author)}</p></div>` +
    (chapters.length > 1
      ? `<nav class="toc"><h1>Contents</h1><ol>${chapters.map((c) => `<li>${book.kind === "novel" || book.kind === "puzzle" ? `${c.i + 1}. ` : ""}${xmlEsc(c.title)}</li>`).join("")}${answers.length ? "<li>Answer key</li>" : ""}</ol></nav>`
      : "") +
    chapters.map((c) => `<section class="chapter">${chapterHeading(book, c.i, c.title)}${chapterHtml(c.text ?? "")}${c.puzzle && puzzleReady(c.puzzle) ? puzzleHtml(c.puzzle) : ""}</section>`).join("") +
    (answers.length ? `<section class="chapter"><h1>Answer key</h1>${answers.map((c) => answerHtml(c.puzzle!, c.title, c.i + 1)).join("")}</section>` : "") +
    `<div class="blank"></div>`.repeat(pad) +
    `</body></html>`
  );
}
