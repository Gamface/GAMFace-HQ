// Tests for niche research.   npm test
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ResearchStore,
  competitionOf,
  conceptsPrompt,
  isBlockedPage,
  mineKeywords,
  newResearch,
  parseConcepts,
  parseResults,
  parseSuggestions,
  rankSuggestions,
  scoreKeywords,
  searchUrl,
  suggestUrl,
} from "../src/hq/research";
import type { Research } from "../src/hq/research";

test("Research: a niche is needed; markets map to Amazon's departments", () => {
  assert.deepEqual(newResearch({ seed: "x" }), { error: "Give a niche to research (a word or two, like “dog training” or “cozy mystery”)" });
  const r = newResearch({ seed: "  Dog   TRAINING ", market: "kindle", project: "general" }) as Research;
  assert.equal(r.seed, "dog training");
  assert.equal(r.market, "kindle");
  assert.equal(r.project, null);
  assert.match(suggestUrl("dog training a", "books"), /alias=stripbooks&prefix=dog%20training%20a&/);
  assert.match(suggestUrl("x", "kindle"), /alias=digital-text/);
  assert.equal(searchUrl("dog training", "books"), "https://www.amazon.com/s?k=dog%20training&i=stripbooks");
});

test("Research: suggestions are ranked by how early and how often Amazon offers them", () => {
  assert.deepEqual(parseSuggestions({ suggestions: [{ value: "Dog Training Book", type: "KEYWORD" }, { value: "x", type: "WIDGET" }, {}] }), ["dog training book"]);
  assert.deepEqual(parseSuggestions("nonsense"), []);
  const ranked = rankSuggestions("dog training", [
    { prefix: "dog training", items: ["dog training book", "dog training for puppies", "dog treats"] },
    { prefix: "dog training b", items: ["dog training book", "dog training bible"] },
    { prefix: "dog training p", items: ["dog training for puppies", "dog training book"] },
    { prefix: "dog training z", items: ["zebra stripes"] },
  ]);
  assert.deepEqual(ranked.map((k) => k.text), ["dog training book", "dog training for puppies", "dog treats", "dog training bible"]);
  assert.equal(ranked[0].demand, 100);
  assert.equal(ranked[0].letters, 3);
  assert.ok(!ranked.some((k) => k.text === "zebra stripes"), "off-niche suggestions are dropped");
  // 22 (bare niche, first) + 11 + 10 = 43 against 20 + 11 = 31 for puppies
  assert.equal(ranked[1].demand, Math.round((20 + 11) / 43 * 100));
});

test("Research: mining asks for the niche and every letter, and survives some failures", async () => {
  const asked: string[] = [];
  const fake = (async (url: string) => {
    const prefix = decodeURIComponent(/prefix=([^&]+)/.exec(url)![1]);
    asked.push(prefix);
    if (prefix.endsWith(" q")) return new Response("", { status: 503 });
    return Response.json({ suggestions: [{ value: `${prefix}xx` }, { value: "cozy mystery series" }] });
  }) as typeof fetch;
  const out = await mineKeywords("cozy mystery", "books", { fetchImpl: fake });
  assert.equal(asked.length, 27);
  assert.equal(asked[0], "cozy mystery");
  assert.equal(asked[26], "cozy mystery z");
  assert.equal(out.failed, 1);
  assert.equal(out.keywords[0].text, "cozy mystery series", "suggested for every letter");
  assert.equal(out.keywords[0].letters, 26);
  await assert.rejects(mineKeywords("cozy mystery", "books", { fetchImpl: (async () => new Response("", { status: 500 })) as typeof fetch }), /couldn't be reached/);
});

const result = (asin: string, opts: { title: string; rating?: string; reviews?: string; price?: string; sponsored?: boolean; aria?: boolean }) =>
  `<div data-asin="${asin}" data-index="1" data-component-type="s-search-result" class="s-result-item">` +
  (opts.sponsored ? `<span class="puis-sponsored-label-text">Sponsored</span>` : "") +
  `<h2 ${opts.aria ? `aria-label="${opts.title}"` : ""} class="a-size-mini"><a><span class="a-text-normal">${opts.title}</span></a></h2>` +
  (opts.rating ? `<span class="a-icon-alt">${opts.rating} out of 5 stars</span>` : "") +
  (opts.reviews ? `<a><span aria-label="${opts.reviews} ratings" class="a-size-base s-underline-text">${opts.reviews}</span></a>` : "") +
  (opts.price ? `<span class="a-price"><span class="a-offscreen">$${opts.price}</span></span>` : "") +
  `</div>`;

test("Research: listings are read from a results page, sponsored ones marked", () => {
  const html =
    `<html><body><div data-component-type="s-search-result">no asin</div>` +
    result("B000000001", { title: "Puppy Training &amp; You", rating: "4.6", reviews: "12,345", price: "14.99" }) +
    result("B000000002", { title: "Sponsored Ad - Big Dog Book", rating: "4.1", reviews: "2.3K", price: "9.99", sponsored: true, aria: true }) +
    result("B000000003", { title: "New Dog Guide", reviews: "37" }) +
    `</body></html>`;
  const list = parseResults(html);
  assert.deepEqual(list, [
    { asin: "B000000001", title: "Puppy Training & You", rating: 4.6, reviews: 12345, price: 14.99, sponsored: false },
    { asin: "B000000002", title: "Big Dog Book", rating: 4.1, reviews: 2300, price: 9.99, sponsored: true },
    { asin: "B000000003", title: "New Dog Guide", rating: undefined, reviews: 37, price: undefined, sponsored: false },
  ]);
  assert.ok(isBlockedPage("<title>Robot Check</title><form action='/errors/validateCaptcha'>"));
  assert.ok(!isBlockedPage(html));
});

test("Research: competition counts organic listings only; the score favours demand with weak competition", () => {
  const c = competitionOf([
    { asin: "A", title: "a", reviews: 10, price: 10, rating: 4, sponsored: false },
    { asin: "B", title: "b", reviews: 5000, price: 20, rating: 5, sponsored: false },
    { asin: "C", title: "c", reviews: 50, sponsored: false },
    { asin: "D", title: "ad", reviews: 99999, sponsored: true },
  ]);
  assert.deepEqual(c, { results: 3, medianReviews: 50, lowShare: 0.67, avgPrice: 15, avgRating: 4.5, titles: ["a", "b", "c"], sponsored: 1 });
  const scored = scoreKeywords([
    { text: "crowded", demand: 100, letters: 5, competition: { ...c, medianReviews: 20000, lowShare: 0 } },
    { text: "open", demand: 60, letters: 3, competition: { ...c, medianReviews: 30, lowShare: 0.8 } },
    { text: "unchecked", demand: 90, letters: 4 },
  ]);
  assert.equal(scored.find((k) => k.text === "open")!.score, 100);
  assert.ok(scored.find((k) => k.text === "crowded")!.score! < 30);
  assert.equal(scored.find((k) => k.text === "unchecked")!.score, undefined);
});

test("Research: the concepts prompt carries only the measured numbers; concepts are checked", () => {
  const r = newResearch({ seed: "dog training" }) as Research;
  r.keywords = scoreKeywords([
    { text: "dog training for puppies", demand: 80, letters: 6, competition: { results: 14, medianReviews: 45, lowShare: 0.57, avgPrice: 12.5, avgRating: 4.4, titles: ["Puppy 101", "Good Dog"], sponsored: 2 } },
    { text: "dog training book", demand: 100, letters: 9 },
  ]);
  const m = conceptsPrompt(r);
  assert.match(m[0].content, /never invent sales, search volumes or rankings/);
  assert.match(m[1].content, /"dog training for puppies": demand 80\/100, opportunity 100\/100; first page: median 45 reviews, 57% under 100 reviews, average price \$12\.5; top titles: Puppy 101 \| Good Dog/);
  assert.match(m[1].content, /Other suggested phrases: dog training book/);
  const parsed = parseConcepts({
    summary: "Puppy guides are wide open.",
    concepts: [
      { title: "Puppy in 10 Minutes a Day", kind: "ebook", keyword: "dog training for puppies", angle: "Short daily drills", audience: "New owners", brief: "A short daily-drill guide for new puppy owners with busy lives.", why: "57% under 100 reviews" },
      { title: "Bad", kind: "comic", brief: "too short" },
      { title: "Rex Saves the Day", kind: "comic", brief: "A picture book where a puppy learns to sit and stay, told in rhyme." },
    ],
  });
  assert.ok(!("error" in parsed));
  assert.equal(parsed.concepts.length, 2);
  assert.equal(parsed.concepts[1].kind, "ebook", "an unknown kind becomes an ebook");
  assert.equal(parsed.summary, "Puppy guides are wide open.");
  assert.deepEqual(parseConcepts({}), { error: "The model proposed no usable concepts" });
});

test("Research: saved per item; research cut off by a restart is marked failed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "research-"));
  const store = new ResearchStore(dir);
  const a = newResearch({ seed: "cozy mystery" }) as Research;
  store.save(a);
  const b = { ...(newResearch({ seed: "budget planner" }) as Research), status: "done" as const };
  store.save(b);
  const again = new ResearchStore(dir);
  assert.equal(again.get(a.id)?.status, "failed");
  assert.match(again.get(a.id)!.error!, /Interrupted/);
  assert.equal(again.get(b.id)?.status, "done");
  assert.ok(again.delete(a.id));
  assert.equal(new ResearchStore(dir).list().length, 1);
});
