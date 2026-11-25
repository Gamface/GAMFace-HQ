// Source material for books: your own blog posts, Google Docs, Word files, PDFs, YouTube
// videos, recordings and pasted notes, turned into plain text the Writer can repurpose.
// Web pages are fetched here with the browser's address checks on every redirect (no
// private-network addresses), and only their readable text is kept.

import { inflateRawSync } from "node:zlib";
import { blockedReason } from "./browser";

export type SourceKind = "url" | "youtube" | "pdf" | "docx" | "text" | "audio";

export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  /** Where it came from: a web address, or a file name */
  origin?: string;
  text: string;
  addedAt: number;
}

export const MAX_SOURCE_CHARS = 400_000;
export const MAX_SOURCES_CHARS = 2_000_000;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

// --- Text from markup -----------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß", deg: "°", middot: "·", bull: "•",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const tidy = (s: string) =>
  s
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * The readable text of a web page as light Markdown: headings, paragraphs, lists and
 * quotes. Menus, headers, footers, sidebars, scripts and forms are dropped, and the
 * page's <article> or <main> is used when it has one.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const titleTag = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|form|button|select|canvas|video|audio|picture|figure)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, "");
  // The main content, when the page marks it: the longest <article>, else <main>
  const articles = [...body.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => m[0]).sort((a, b) => b.length - a.length);
  const main = articles[0] ?? /<main\b[\s\S]*?<\/main>/i.exec(body)?.[0];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 400) body = main;
  const text = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Math.min(Number(n) + 1, 6))} ${t.replace(/<[^>]+>/g, " ").trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<blockquote\b[^>]*>/gi, "\n\n> ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|ul|ol|table|tr|blockquote|pre)>/gi, "\n\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  return { title: tidy(decodeEntities(titleTag.replace(/<[^>]+>/g, ""))).split("\n")[0].slice(0, 200), text: tidy(decodeEntities(text)) };
}

// --- ZIP files (Word documents) ---------------------------------------------------------

/** Reads a ZIP archive through its central directory, so files written with data descriptors work too. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("That file isn't a ZIP archive (or a Word document)");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 }));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The text of a Word (.docx) document, with headings and list items kept. */
export function docxToText(buf: Buffer): string {
  const doc = readZip(buf).get("word/document.xml");
  if (!doc) throw new Error("That file isn't a Word document (.docx)");
  const xml = doc.toString("utf8");
  const paras: string[] = [];
  for (const m of xml.matchAll(/<w:p(?:\s[^>]*[^/])?>([\s\S]*?)<\/w:p>/g)) {
    const p = m[1];
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "";
    // Runs of text, tabs and line breaks, in order (a <w:tab .../> with attributes is a tab stop, not a tab)
    const text = decodeEntities(
      [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>/g)].map((m) => m[1] ?? (m[0].startsWith("<w:tab") ? "\t" : "\n")).join(""),
    ).trim();
    if (!text) continue;
    const heading = /^(Title|Heading(\d))$/i.exec(style);
    if (heading) paras.push(`${"#".repeat(heading[2] ? Math.min(Number(heading[2]) + 1, 6) : 1)} ${text}`);
    else if (/<w:numPr>/.test(p)) paras.push(`- ${text}`);
    else paras.push(text);
  }
  return tidy(paras.join("\n\n"));
}

// --- Fetching -----------------------------------------------------------------------------

export interface FetchOptions {
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Fetches a URL with the address check on every redirect. */
async function safeFetch(url: string, opts: FetchOptions, accept = "text/html,text/plain,application/pdf,*/*;q=0.5"): Promise<{ buf: Buffer; type: string; url: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    const blocked = await blockedReason(at, opts.allowPrivate);
    if (blocked) throw new Error(`Can't fetch ${new URL(at).hostname}: ${blocked}`);
    const res = await doFetch(at, {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      headers: { Accept: accept, "Accept-Language": "en-US,en;q=0.8", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      at = new URL(res.headers.get("location")!, at).toString();
      continue;
    }
    if (!res.ok) throw new Error(`${new URL(at).hostname} answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (is it private? Share it publicly, or download it and add the file instead)" : ""}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_FETCH_BYTES) throw new Error("That page is too large (over 8 MB)");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES) throw new Error("That page is too large (over 8 MB)");
    return { buf, type: (res.headers.get("content-type") ?? "").toLowerCase(), url: at };
  }
  throw new Error("Too many redirects");
}

export function youtubeId(url: string): string | null {
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(url);
  return m?.[1] ?? null;
}

/** Captions as plain text, from YouTube's caption XML or JSON. Exported for tests. */
export function captionText(body: string): string {
  if (body.trimStart().startsWith("{")) {
    const j = JSON.parse(body) as { events?: { segs?: { utf8?: string }[] }[] };
    return tidy((j.events ?? []).map((e) => (e.segs ?? []).map((s) => s.utf8 ?? "").join("")).join(" ").replace(/\s+/g, " "));
  }
  const parts = [...body.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g)].map((m) => decodeEntities(decodeEntities(m[1].replace(/<[^>]+>/g, ""))));
  return tidy(parts.join(" ").replace(/\s+/g, " "));
}

/** A YouTube video's captions (its own or the automatic ones), and its title. */
async function youtubeTranscript(id: string, opts: FetchOptions): Promise<{ title: string; text: string }> {
  const page = (await safeFetch(`https://www.youtube.com/watch?v=${id}&hl=en`, opts)).buf.toString("utf8");
  const title = decodeEntities(/<meta name="title" content="([^"]*)"/.exec(page)?.[1] ?? /<title>([^<]*)<\/title>/.exec(page)?.[1]?.replace(/ - YouTube$/, "") ?? `YouTube ${id}`);
  const m = /"captionTracks":(\[[\s\S]*?\])/.exec(page);
  const noCaptions = new Error(
    "This video's captions couldn't be read (it may have none, or YouTube refused). Download the audio and add it as a recording, or paste the transcript (YouTube: ⋯ → Show transcript) as text.",
  );
  if (!m) throw noCaptions;
  let tracks: { baseUrl: string; languageCode?: string; kind?: string }[];
  try {
    tracks = JSON.parse(m[1]);
  } catch {
    throw noCaptions;
  }
  // English made by a person first, then automatic English, then anything
  const pick = tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr") ?? tracks.find((t) => t.languageCode?.startsWith("en")) ?? tracks[0];
  if (!pick?.baseUrl) throw noCaptions;
  const body = (await safeFetch(pick.baseUrl.replace(/\\u0026/g, "&"), opts, "*/*")).buf.toString("utf8");
  const text = body.trim() ? captionText(body) : "";
  if (text.length < 50) throw noCaptions;
  return { title, text };
}

/**
 * Text from a web address: a page (its readable text), a public Google Doc, a YouTube
 * video (its captions), a plain text file, or a PDF or Word file (returned as bytes for
 * the caller to read).
 */
export async function fetchSource(url: string, opts: FetchOptions = {}): Promise<{ kind: SourceKind; title: string; text: string } | { kind: "pdf" | "docx"; title: string; buf: Buffer }> {
  const yt = youtubeId(url);
  if (yt) return { kind: "youtube", ...(await youtubeTranscript(yt, opts)) };
  const gdoc = /docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{20,})/.exec(url);
  if (gdoc) {
    const got = await safeFetch(`https://docs.google.com/document/d/${gdoc[1]}/export?format=txt`, opts, "text/plain");
    const text = tidy(got.buf.toString("utf8").replace(/^﻿/, "").replace(/\r/g, ""));
    if (/<html/i.test(text.slice(0, 200))) throw new Error("That Google Doc isn't public. Share it as \"Anyone with the link\", or download it as Word and add the file.");
    return { kind: "url", title: text.split("\n")[0].slice(0, 120) || "Google Doc", text };
  }
  const got = await safeFetch(url, opts);
  const name = decodeURIComponent(new URL(got.url).pathname.split("/").pop() || new URL(got.url).hostname);
  if (got.type.includes("pdf") || got.buf.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", title: name, buf: got.buf };
  if (got.type.includes("officedocument.wordprocessingml") || /\.docx$/i.test(name)) return { kind: "docx", title: name, buf: got.buf };
  const raw = got.buf.toString("utf8");
  if (got.type.startsWith("text/plain") || got.type.includes("markdown")) return { kind: "url", title: name, text: tidy(raw) };
  const page = htmlToText(raw);
  if (page.text.length < 200) throw new Error("That page had almost no readable text (it may need a browser to show it). Copy the text and paste it instead.");
  return { kind: "url", title: page.title || name, text: page.text };
}

// --- Using sources -----------------------------------------------------------------------

export interface Chunk {
  i: number;
  source: string;
  text: string;
}

/** Splits the sources into pieces of about `size` characters, at paragraph breaks. */
export function chunkSources(sources: Source[], size = 3500): Chunk[] {
  const out: Chunk[] = [];
  for (const s of sources) {
    let cur = "";
    const flush = () => {
      if (cur.trim()) out.push({ i: out.length, source: s.name, text: cur.trim() });
      cur = "";
    };
    for (const para of s.text.split(/\n{2,}/)) {
      // A very long paragraph (a transcript with no breaks) is cut at sentences
      const pieces = para.length > size ? para.match(new RegExp(`[\\s\\S]{1,${size}}(?:[.!?]\\s|$)`, "g")) ?? [para] : [para];
      for (const p of pieces) {
        if (cur.length + p.length > size) flush();
        cur += (cur ? "\n\n" : "") + p;
      }
    }
    flush();
  }
  return out;
}

const STOP = new Set(
  "about above after again against also because been before being below between both could does doing down during each from further have having here hers herself himself into itself just more most other ours ourselves over same should some such than that their theirs them themselves then there these they this those through under until very what when where which while whom will with would your yours yourself yourselves chapter".split(" "),
);
const terms = (s: string) => (s.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, ""));

/**
 * The chunks that best match `query` (term overlap, rarer words count more), as many as
 * fit in `budget` characters, in their original order.
 */
export function rankChunks(chunks: Chunk[], query: string, budget: number): Chunk[] {
  const q = [...new Set(terms(query))];
  if (!q.length || !chunks.length) return [];
  const docs = chunks.map((c) => {
    const tf = new Map<string, number>();
    for (const t of terms(c.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.has(t)).length]));
  const scored = chunks
    .map((c, i) => ({ c, score: q.reduce((n, t) => n + (docs[i].has(t) ? (1 + Math.log(docs[i].get(t)!)) * Math.log(1 + chunks.length / df.get(t)!) : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const picked: Chunk[] = [];
  let used = 0;
  for (const { c } of scored) {
    if (used + c.text.length > budget) continue;
    picked.push(c);
    used += c.text.length;
  }
  return picked.sort((a, b) => a.i - b.i);
}
