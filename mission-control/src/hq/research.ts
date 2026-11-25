// Niche research for books: what buyers search for on Amazon, and how crowded those
// searches are.
//
//   1. Demand: Amazon's own search suggestions for the niche, then niche + a … niche + z
//      (the "A–Z" method). A phrase Amazon suggests early and for many letters is one
//      buyers type often. These are relative signals, not search volumes; those only
//      come from paid tools.
//   2. Competition: for the strongest phrases, the Amazon search results page is opened
//      in the browser sidecar (a throwaway profile, no pictures) and each organic listing's
//      review count, rating and price are read.
//   3. Score: demand against how established the first page is (median reviews, and how
//      many listings have under 100 reviews).
//   4. Concepts: the Writer turns the numbers into three book ideas, each one click away
//      from a new book.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Cdp, resolveCdpUrl } from "./browser";
import type { ChatMessage } from "./ollama";
import { decodeEntities } from "./sources";

export type Market = "books" | "kindle";
export type ResearchStatus = "mining" | "competition" | "thinking" | "done" | "failed";

export interface Competition {
  /** Organic (not sponsored) listings read */
  results: number;
  medianReviews: number;
  /** Share of listings with fewer than 100 reviews */
  lowShare: number;
  avgPrice?: number;
  avgRating?: number;
  /** The first few titles, so you can see who you'd be up against */
  titles: string[];
  sponsored: number;
}

export interface Keyword {
  text: string;
  /** 0–100, relative to the strongest phrase in this research */
  demand: number;
  /** For how many of the 27 prefixes Amazon suggested it */
  letters: number;
  competition?: Competition;
  /** 0–100, demand against competition (only for phrases whose competition was read) */
  score?: number;
}

export interface Concept {
  title: string;
  kind: "novel" | "ebook" | "picture" | "puzzle";
  keyword: string;
  angle: string;
  audience: string;
  brief: string;
  why: string;
}

export interface Research {
  id: string;
  seed: string;
  market: Market;
  status: ResearchStatus;
  error?: string;
  /** What happened along the way ("Amazon showed a robot check…") */
  notes: string[];
  keywords: Keyword[];
  concepts?: Concept[];
  summary?: string;
  project: string | null;
  createdAt: number;
  updatedAt: number;
}

export const RESEARCH_ID = /^[a-f0-9]{12}$/;
const ALIAS: Record<Market, string> = { books: "stripbooks", kindle: "digital-text" };
const DEPT: Record<Market, string> = { books: "stripbooks", kindle: "digital-text" };
export const COMPETITION_CHECKS = 8;

export function newResearch(input: Record<string, unknown>): Research | { error: string } {
  const seed = typeof input.seed === "string" ? input.seed.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80) : "";
  if (seed.length < 3) return { error: "Give a niche to research (a word or two, like “dog training” or “cozy mystery”)" };
  const now = Date.now();
  return {
    id: randomBytes(6).toString("hex"),
    seed,
    market: input.market === "kindle" ? "kindle" : "books",
    status: "mining",
    notes: [],
    keywords: [],
    project: typeof input.project === "string" && input.project && input.project !== "general" ? input.project : null,
    createdAt: now,
    updatedAt: now,
  };
}

// --- Demand: Amazon's search suggestions -------------------------------------------------

export const suggestUrl = (prefix: string, market: Market) =>
  `https://completion.amazon.com/api/2017/suggestions?mid=ATVPDKIKX0DER&alias=${ALIAS[market]}&prefix=${encodeURIComponent(prefix)}&limit=11&suggestion-type=KEYWORD&site-variant=desktop&client-info=amazon-search-ui&lop=en_US`;

/** The phrases in a suggestions reply, in order. */
export function parseSuggestions(json: unknown): string[] {
  const list = (json as { suggestions?: { value?: unknown; type?: unknown }[] })?.suggestions;
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => !s.type || s.type === "KEYWORD")
    .map((s) => (typeof s.value === "string" ? s.value.trim().toLowerCase() : ""))
    .filter(Boolean);
}

/**
 * Demand from the suggestions: a phrase gets more points the earlier it's suggested,
 * double for the bare niche, and is ranked by points (ties: more letters).
 */
export function rankSuggestions(seed: string, lists: { prefix: string; items: string[] }[]): Keyword[] {
  const pts = new Map<string, { points: number; letters: Set<string> }>();
  for (const { prefix, items } of lists) {
    items.forEach((text, pos) => {
      if (!text.includes(seed.split(" ")[0])) return; // suggestions that wandered off the niche
      const p = pts.get(text) ?? { points: 0, letters: new Set<string>() };
      p.points += (11 - Math.min(pos, 10)) * (prefix === seed ? 2 : 1);
      p.letters.add(prefix);
      pts.set(text, p);
    });
  }
  const sorted = [...pts.entries()].sort((a, b) => b[1].points - a[1].points || b[1].letters.size - a[1].letters.size);
  const top = sorted[0]?.[1].points || 1;
  return sorted.slice(0, 60).map(([text, p]) => ({ text, demand: Math.round((p.points / top) * 100), letters: p.letters.size }));
}

/** Asks Amazon for suggestions for the niche and niche + each letter. */
export async function mineKeywords(seed: string, market: Market, opts: { fetchImpl?: typeof fetch; delayMs?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<{ keywords: Keyword[]; failed: number }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const prefixes = [seed, ..."abcdefghijklmnopqrstuvwxyz".split("").map((l) => `${seed} ${l}`)];
  const lists: { prefix: string; items: string[] }[] = [];
  let failed = 0;
  for (const [i, prefix] of prefixes.entries()) {
    try {
      const res = await doFetch(suggestUrl(prefix, market), {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(String(res.status));
      lists.push({ prefix, items: parseSuggestions(await res.json()) });
    } catch {
      failed++;
    }
    opts.onProgress?.(i + 1, prefixes.length);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  if (failed === prefixes.length) throw new Error("Amazon's search suggestions couldn't be reached (no internet, or Amazon refused)");
  return { keywords: rankSuggestions(seed, lists), failed };
}

// --- Competition: the search results page ------------------------------------------------

export const searchUrl = (keyword: string, market: Market) => `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}&i=${DEPT[market]}`;

export interface Listing {
  asin: string;
  title: string;
  rating?: number;
  reviews: number;
  price?: number;
  sponsored: boolean;
}

/** Whether Amazon showed a robot check instead of results. */
export const isBlockedPage = (html: string) => /Robot Check|validateCaptcha|captcha|api-services-support@amazon\.com|make sure you're not a robot/i.test(html.slice(0, 200_000));

const toNumber = (s: string) => {
  const m = /([\d.,]+)\s*([KkMm])?/.exec(s.replace(/\s/g, ""));
  if (!m) return NaN;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return m[2] ? n * (/k/i.test(m[2]) ? 1000 : 1_000_000) : n;
};

/** Listings from an Amazon search results page's HTML. Exported for tests. */
export function parseResults(html: string): Listing[] {
  const opens = [...html.matchAll(/<div\b[^>]*data-component-type="s-search-result"[^>]*>/g)];
  const out: Listing[] = [];
  for (const [i, m] of opens.entries()) {
    const asin = /data-asin="([A-Z0-9]{10})"/.exec(m[0])?.[1];
    if (!asin) continue;
    const block = html.slice(m.index!, opens[i + 1]?.index ?? Math.min(html.length, m.index! + 60_000));
    const title = decodeEntities(/<h2[^>]*aria-label="([^"]+)"/.exec(block)?.[1] ?? /<h2[\s\S]*?<span[^>]*>([^<]+)<\/span>/.exec(block)?.[1] ?? "")
      .replace(/^Sponsored Ad - /, "")
      .trim();
    const rating = toNumber(/([0-5](?:\.\d)?) out of 5 stars/.exec(block)?.[1] ?? "");
    const reviewText = /aria-label="([\d.,]+[KkMm]?) (?:ratings?|reviews?)"/.exec(block)?.[1] ?? /s-underline-text">\(?([\d.,]+[KkMm]?)\)?</.exec(block)?.[1] ?? "";
    const reviews = toNumber(reviewText);
    const price = toNumber(/<span class="a-offscreen">\$([\d,.]+)<\/span>/.exec(block)?.[1] ?? "");
    out.push({
      asin,
      title: title.slice(0, 200),
      rating: Number.isFinite(rating) ? rating : undefined,
      reviews: Number.isFinite(reviews) ? Math.round(reviews) : 0,
      price: Number.isFinite(price) ? price : undefined,
      sponsored: /puis-sponsored-label|>Sponsored<|Sponsored Ad/i.test(block),
    });
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : undefined);

/** The first page's numbers, from its organic listings. */
export function competitionOf(listings: Listing[]): Competition {
  const organic = listings.filter((l) => !l.sponsored).slice(0, 16);
  const reviews = organic.map((l) => l.reviews);
  return {
    results: organic.length,
    medianReviews: median(reviews),
    lowShare: organic.length ? Math.round((reviews.filter((r) => r < 100).length / organic.length) * 100) / 100 : 0,
    avgPrice: mean(organic.map((l) => l.price).filter((p): p is number => p !== undefined)),
    avgRating: mean(organic.map((l) => l.rating).filter((r): r is number => r !== undefined)),
    titles: organic.slice(0, 5).map((l) => l.title),
    sponsored: listings.length - listings.filter((l) => !l.sponsored).length,
  };
}

/**
 * Demand against competition, 0–100 across the phrases checked: high demand, a low
 * median review count and many listings under 100 reviews score best.
 */
export function scoreKeywords(keywords: Keyword[]): Keyword[] {
  const raw = keywords.map((k) => (k.competition && k.competition.results ? (k.demand * (0.4 + k.competition.lowShare)) / (1 + Math.log10(1 + k.competition.medianReviews)) : undefined));
  const top = Math.max(0, ...raw.filter((x): x is number => x !== undefined)) || 1;
  return keywords.map((k, i) => (raw[i] === undefined ? { ...k, score: undefined } : { ...k, score: Math.round((raw[i]! / top) * 100) }));
}

/**
 * Opens a page in the browser sidecar and returns its HTML: a throwaway profile, with
 * pictures, fonts and media not downloaded. The page's own scripts run (Amazon needs them).
 */
export async function renderPage(url: string, cdpBase: string, timeoutMs = 25000): Promise<string> {
  const cdp = await Cdp.connect(await resolveCdpUrl(cdpBase));
  let targetId = "";
  let contextId = "";
  try {
    contextId = (await cdp.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
    targetId = (await cdp.send("Target.createTarget", { url: "about:blank", browserContextId: contextId })).targetId;
    const { sessionId: s } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    let loaded: () => void = () => {};
    const load = new Promise<void>((r) => (loaded = r));
    cdp.on((method, params, sid) => {
      if (sid !== s) return;
      if (method === "Page.loadEventFired") loaded();
      if (method === "Fetch.requestPaused") {
        const skip = ["Image", "Media", "Font"].includes(params.resourceType);
        void cdp.send(skip ? "Fetch.failRequest" : "Fetch.continueRequest", skip ? { requestId: params.requestId, errorReason: "BlockedByClient" } : { requestId: params.requestId }, s).catch(() => {});
      }
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s);
    await cdp.send("Page.enable", {}, s);
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", acceptLanguage: "en-US,en;q=0.9" }, s);
    await cdp.send("Page.navigate", { url }, s);
    await Promise.race([load, new Promise((r) => setTimeout(r, timeoutMs))]);
    await new Promise((r) => setTimeout(r, 800));
    const { result } = await cdp.send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true }, s);
    return String(result?.value ?? "");
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    if (contextId) await cdp.send("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => {});
    cdp.close();
  }
}

// --- Concepts -----------------------------------------------------------------------------

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function conceptsPrompt(r: Research): ChatMessage[] {
  const checked = r.keywords.filter((k) => k.competition);
  const rows = (checked.length ? [...checked].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) : r.keywords.slice(0, 15)).map((k) =>
    k.competition
      ? `- "${k.text}": demand ${k.demand}/100, opportunity ${k.score ?? "?"}/100; first page: median ${k.competition.medianReviews} reviews, ${pct(k.competition.lowShare)} under 100 reviews` +
        `${k.competition.avgPrice ? `, average price $${k.competition.avgPrice}` : ""}; top titles: ${k.competition.titles.slice(0, 3).join(" | ")}`
      : `- "${k.text}": demand ${k.demand}/100 (competition not checked)`,
  );
  const more = r.keywords.filter((k) => !k.competition).slice(0, 25).map((k) => k.text);
  return [
    {
      role: "system",
      content:
        "You are a self-publishing strategist. You find book ideas where buyers are searching but the first page of results is weak or generic, and you give each idea a clear angle that sets it apart. Use only the numbers given; never invent sales, search volumes or rankings. Reply with JSON only.",
    },
    {
      role: "user",
      content:
        `Niche: "${r.seed}" (Amazon ${r.market === "kindle" ? "Kindle ebooks" : "books"}).\n\nPhrases buyers search for, from Amazon's own suggestions (demand is relative to the strongest phrase):\n${rows.join("\n")}\n` +
        (more.length ? `\nOther suggested phrases: ${more.join("; ")}\n` : "") +
        `\nPropose 3 book concepts this tool can make. Each must be one of: "ebook" (nonfiction), "novel", "picture" (children's picture book) or "puzzle" (whodunit or logic puzzle book). ` +
        `Reply as {"summary": "2–3 sentences on what the numbers show", "concepts": [{"title": "…", "kind": "ebook|novel|picture|puzzle", "keyword": "the phrase it targets", ` +
        `"angle": "what makes it different from the titles already there", "audience": "…", "brief": "3–4 sentences the author can use as the book's brief", "why": "which numbers point to it"}]}`,
    },
  ];
}

export function parseConcepts(json: Record<string, unknown>): { concepts: Concept[]; summary?: string } | { error: string } {
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const list = Array.isArray(json.concepts) ? json.concepts : [];
  const concepts = list
    .map((raw) => (raw ?? {}) as Record<string, unknown>)
    .map(
      (c): Concept => ({
        title: s(c.title, 200),
        kind: (["novel", "ebook", "picture", "puzzle"] as const).find((k) => k === c.kind) ?? "ebook",
        keyword: s(c.keyword, 120),
        angle: s(c.angle, 600),
        audience: s(c.audience, 300),
        brief: s(c.brief, 2000),
        why: s(c.why, 600),
      }),
    )
    .filter((c) => c.title && c.brief.length >= 20)
    .slice(0, 5);
  if (!concepts.length) return { error: "The model proposed no usable concepts" };
  return { concepts, summary: s(json.summary, 1000) || undefined };
}

// --- Saving -------------------------------------------------------------------------------

export class ResearchStore {
  private items = new Map<string, Research>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!/^[a-f0-9]{12}\.json$/.test(f)) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Research;
        // Research cut off by a restart is marked as such rather than left "running"
        if (r.status !== "done" && r.status !== "failed") Object.assign(r, { status: "failed", error: "Interrupted by a restart: run it again" });
        if (RESEARCH_ID.test(r.id)) this.items.set(r.id, r);
      } catch {
        // left where it is
      }
    }
  }

  list(project?: string | null): Research[] {
    return [...this.items.values()].filter((r) => project === undefined || r.project === project || r.project === null).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Research | undefined {
    return RESEARCH_ID.test(id) ? this.items.get(id) : undefined;
  }

  save(r: Research) {
    r.updatedAt = Date.now();
    this.items.set(r.id, r);
    const file = path.join(this.dir, `${r.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(r));
    renameSync(`${file}.tmp`, file);
  }

  delete(id: string): boolean {
    if (!this.items.delete(id)) return false;
    const file = path.join(this.dir, `${id}.json`);
    if (existsSync(file)) rmSync(file);
    return true;
  }
}
