// Amazon KDP paperback files: an interior whose inside (gutter) margin matches its page
// count, a full cover (back, spine and front with bleed, sized from the page count and
// paper), and a listing kit (description, keywords, categories). The numbers follow KDP's
// published paperback rules; KDP's previewer still has the final word, so check the
// files there before publishing.

import type { ChatMessage } from "./ollama";
import { xmlEsc } from "./epub";

export type Paper = "white" | "cream" | "color";

/** Inches of spine per page */
export const SPINE_PER_PAGE: Record<Paper, number> = { white: 0.002252, cream: 0.0025, color: 0.002347 };
export const BLEED = 0.125;
export const MIN_PAGES = 24;
export const MAX_PAGES = 828;
/** Books with fewer pages can't have text on the spine */
export const SPINE_TEXT_MIN_PAGES = 80;

/** Trim sizes in inches: [width, height] */
export const TRIM_INCHES = {
  "5x8": [5, 8],
  "5.5x8.5": [5.5, 8.5],
  "6x9": [6, 9],
  a5: [5.83, 8.27],
  "8x10": [8, 10],
  "8.5x8.5": [8.5, 8.5],
  "8.5x11": [8.5, 11],
  letter: [8.5, 11],
} as const;
export type KdpTrim = keyof typeof TRIM_INCHES;

/** KDP's minimum inside margin for a page count. */
export function gutterFor(pages: number): number {
  if (pages <= 150) return 0.375;
  if (pages <= 300) return 0.5;
  if (pages <= 500) return 0.625;
  if (pages <= 700) return 0.75;
  return 0.875;
}

export interface CoverSpec {
  /** Full cover, bleed included */
  width: number;
  height: number;
  spine: number;
  trim: [number, number];
  spineText: boolean;
  /** At 300 dpi, for anyone making the cover elsewhere */
  pixels: [number, number];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function coverSpec(trim: KdpTrim, pages: number, paper: Paper): CoverSpec {
  const [w, h] = TRIM_INCHES[trim];
  const spine = r3(Math.max(pages, MIN_PAGES) * SPINE_PER_PAGE[paper]);
  const width = r3(BLEED + w + spine + w + BLEED);
  const height = r3(BLEED + h + BLEED);
  return { width, height, spine, trim: [w, h], spineText: pages >= SPINE_TEXT_MIN_PAGES, pixels: [Math.round(width * 300), Math.round(height * 300)] };
}

/** Page CSS for a KDP interior: mirrored margins with the gutter on the inside. With bleed, pages are 0.125 in wider and 0.25 in taller. */
export function interiorPageCss(trim: KdpTrim, pages: number, opts: { bleed?: boolean; top?: number; bottom?: number; outside?: number } = {}): string {
  const [w, h] = TRIM_INCHES[trim];
  const gutter = gutterFor(pages);
  if (opts.bleed) {
    // Full-bleed pages are laid out by the page itself; the page box has no margin
    return `@page { size: ${r3(w + BLEED)}in ${r3(h + 2 * BLEED)}in; margin: 0; }`;
  }
  const outside = Math.max(opts.outside ?? 0.5, 0.25);
  const top = opts.top ?? 0.65;
  const bottom = opts.bottom ?? 0.75;
  return (
    `@page { size: ${w}in ${h}in; margin: ${top}in ${outside}in ${bottom}in ${gutter}in; }` +
    `@page :right { margin-left: ${gutter}in; margin-right: ${outside}in; }` +
    `@page :left { margin-left: ${outside}in; margin-right: ${gutter}in; }`
  );
}

// --- Cover --------------------------------------------------------------------------------

export interface CoverInput {
  title: string;
  subtitle?: string;
  author: string;
  /** Back cover text */
  blurb: string;
  /** A data: URI for the front picture */
  image?: string;
  /** Colours for a cover without a picture */
  palette?: { bg: string; fg: string; accent: string };
}

const PALETTES = [
  { bg: "#1f2a44", fg: "#f5efe0", accent: "#d9a441" },
  { bg: "#2d3a2e", fg: "#f2f0e6", accent: "#c9b26b" },
  { bg: "#5b1f2a", fg: "#fbf3ea", accent: "#e8b86d" },
  { bg: "#f3ead8", fg: "#2b2b2b", accent: "#a6452b" },
  { bg: "#123c4a", fg: "#eef6f5", accent: "#7fc8c2" },
];

/** A palette chosen from the title, so a book keeps its colours between prints. */
export function paletteFor(title: string) {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTES[h % PALETTES.length];
}

/**
 * The full paperback cover as one page: back on the left, spine, front on the right,
 * with bleed all round. The barcode area on the back is left clear (KDP prints the
 * barcode there). Text stays 0.25 in inside the trim.
 */
export function coverHtml(spec: CoverSpec, c: CoverInput): string {
  const [w, h] = spec.trim;
  const p = c.palette ?? paletteFor(c.title);
  const safe = 0.375;
  const backLeft = BLEED;
  const spineLeft = BLEED + w;
  const frontLeft = BLEED + w + spec.spine;
  const titleSize = c.title.length > 40 ? 26 : c.title.length > 22 ? 32 : 40;
  const front = c.image
    ? `<div class="front" style="left:${frontLeft}in;width:${w + BLEED}in"><img src="${xmlEsc(c.image)}" alt="">` +
      `<div class="band top"><h1 style="font-size:${titleSize}pt">${xmlEsc(c.title)}</h1>${c.subtitle ? `<p class="sub">${xmlEsc(c.subtitle)}</p>` : ""}</div>` +
      `<div class="band bottom"><p class="author">${xmlEsc(c.author)}</p></div></div>`
    : `<div class="front plain" style="left:${frontLeft}in;width:${w + BLEED}in">` +
      `<div class="inner" style="padding:${safe + 0.6}in ${safe + BLEED}in ${safe + 0.6}in ${safe}in"><div class="rule"></div><h1 style="font-size:${titleSize}pt">${xmlEsc(c.title)}</h1>` +
      `${c.subtitle ? `<p class="sub">${xmlEsc(c.subtitle)}</p>` : ""}<div class="rule"></div><p class="author">${xmlEsc(c.author)}</p></div></div>`;
  const spineText = spec.spineText
    ? `<div class="spine-text" style="width:${h - 0.5}in;font-size:${Math.min(14, Math.max(7, spec.spine * 72 * 0.45))}pt">${xmlEsc(c.title)}<span> · ${xmlEsc(c.author)}</span></div>`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: ${spec.width}in ${spec.height}in; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${spec.width}in; height: ${spec.height}in; }
body { position: relative; background: ${p.bg}; color: ${p.fg}; font-family: Georgia, "Times New Roman", serif; overflow: hidden; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.back, .front, .spine { position: absolute; top: 0; height: ${spec.height}in; }
.back { left: 0; width: ${w + BLEED}in; padding: ${BLEED + safe + 0.3}in ${safe}in ${BLEED + safe}in ${backLeft + safe}in; }
.back h2 { font-size: 15pt; margin-bottom: 0.18in; color: ${p.accent}; font-weight: normal; letter-spacing: 0.04em; }
.back p { font-size: 10.5pt; line-height: 1.5; margin-bottom: 0.12in; }
.barcode { position: absolute; right: ${0.25}in; bottom: ${BLEED + 0.25}in; width: 2in; height: 1.2in; background: #fff; }
.spine { left: ${spineLeft}in; width: ${spec.spine}in; background: ${p.accent}; display: flex; align-items: center; justify-content: center; }
.spine-text { transform: rotate(90deg); white-space: nowrap; text-align: center; color: ${p.bg}; font-weight: bold; letter-spacing: 0.05em; overflow: hidden; }
.spine-text span { font-weight: normal; }
.front { overflow: hidden; }
.front img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.band { position: absolute; left: 0; right: ${BLEED}in; padding: 0.3in ${safe}in; text-align: center; background: rgba(0,0,0,0.38); color: #fff; }
.band.top { top: ${BLEED}in; padding-top: ${safe}in; }
.band.bottom { bottom: ${BLEED}in; padding-bottom: ${safe}in; }
.front h1 { font-weight: normal; line-height: 1.15; }
.front .sub { font-style: italic; font-size: 13pt; margin-top: 0.12in; }
.front .author { font-size: 15pt; letter-spacing: 0.08em; text-transform: uppercase; }
.plain .inner { position: absolute; inset: ${BLEED}in 0; display: flex; flex-direction: column; justify-content: center; text-align: center; gap: 0.25in; }
.plain .rule { height: 2px; background: ${p.accent}; width: 40%; margin: 0 auto; }
.plain .author { margin-top: 0.6in; color: ${p.accent}; }
</style></head><body>
<div class="back"><h2>${xmlEsc(c.title)}</h2>${c.blurb
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((x) => `<p>${xmlEsc(x.trim())}</p>`)
    .join("")}<div class="barcode"></div></div>
<div class="spine">${spineText}</div>
${front}
</body></html>`;
}

// --- Listing kit ------------------------------------------------------------------------

export interface Listing {
  /** For the KDP description box: simple HTML (<p>, <b>, <i>, <ul>, <li>) */
  description: string;
  /** The back-cover text, plain */
  backCover: string;
  /** Up to 7 keyword phrases */
  keywords: string[];
  /** Suggested browse categories, like "Fiction › Mystery › Cozy" */
  categories: string[];
  subtitle?: string;
  /** Children's books */
  ageRange?: string;
  at: number;
}

export function listingPrompt(book: { title: string; subtitle?: string; kind: string; brief: string; genre: string; audience: string; bible: string; chapters: { title: string }[] }): ChatMessage[] {
  const kind = book.kind === "novel" ? "novel" : book.kind === "picture" ? "children's picture book" : book.kind === "puzzle" ? "puzzle book" : "nonfiction book";
  return [
    { role: "system", content: "You write Amazon book listings that sell honestly: specific, benefit-led, no hype words like 'masterpiece', no made-up reviews, awards or bestseller claims. Reply with JSON only." },
    {
      role: "user",
      content:
        `A ${kind}: ${book.title || "untitled"}${book.subtitle ? ` — ${book.subtitle}` : ""}\nBrief: ${book.brief}\n` +
        (book.genre ? `Genre/topic: ${book.genre}\n` : "") +
        (book.audience ? `Audience: ${book.audience}\n` : "") +
        `Plan:\n${book.bible.slice(0, 3000)}\nChapters: ${book.chapters.map((c) => c.title).join("; ").slice(0, 1500)}\n\n` +
        `Write the listing as {"description": "150–300 words of simple HTML using only <p>, <b>, <i>, <ul>, <li>: a hook, what the reader gets, who it's for${book.kind === "novel" ? " (no spoilers past the first act)" : ""}", ` +
        `"backCover": "80–130 words of plain text for the back cover", "keywords": ["7 search phrases a buyer would type, 2–5 words each, not repeating the title or using other authors' names or 'free'/'bestseller'"], ` +
        `"categories": ["3 Amazon browse paths like Fiction › Mystery › Cozy"], "subtitle": "a searchable subtitle if the book has none, else empty"${book.kind === "picture" ? ', "ageRange": "e.g. 3–6"' : ""}}`,
    },
  ];
}

const ALLOWED = /^(p|b|i|em|strong|ul|ol|li|br|h4|h5|h6)$/i;

/** Keeps only the HTML KDP accepts in descriptions. Exported for tests. */
export function cleanDescription(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?([a-z0-9]+)[^>]*>/gi, (m, tag: string) => (ALLOWED.test(tag) ? m.replace(/\s[^>]*?(\/?)>$/, "$1>") : ""))
    .trim()
    .slice(0, 4000);
}

export function parseListing(json: Record<string, unknown>): Listing | { error: string } {
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const description = cleanDescription(s(json.description, 6000));
  if (description.replace(/<[^>]+>/g, "").length < 80) return { error: "The listing had no usable description" };
  const keywords = (Array.isArray(json.keywords) ? json.keywords : [])
    .map((k) => s(k, 50).replace(/["“”]/g, ""))
    .filter((k) => k && !/\b(free|bestsell(er|ing)|kindle unlimited|new release)\b/i.test(k))
    .slice(0, 7);
  return {
    description,
    backCover: s(json.backCover, 1500),
    keywords,
    categories: (Array.isArray(json.categories) ? json.categories : []).map((c) => s(c, 150)).filter(Boolean).slice(0, 3),
    subtitle: s(json.subtitle, 200) || undefined,
    ageRange: s(json.ageRange, 20) || undefined,
    at: Date.now(),
  };
}
