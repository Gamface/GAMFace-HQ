// Tests for repurposed content, picture books, puzzle books and KDP files.   npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { addSource, bookEpub, bookHtml, bookMarkdown, chapterPrompt, chapterSources, newBook, nextStep, outlinePrompt, removeSource, rewriteChapter, runStep, settle } from "../src/hq/books";
import type { Book, BookModel } from "../src/hq/books";
import { unzip, zip } from "../src/hq/epub";
import { BLEED, cleanDescription, coverHtml, coverSpec, gutterFor, interiorPageCss, parseListing } from "../src/hq/kdp";
import type { ChatMessage } from "../src/hq/ollama";
import { answerRows, clueText, countSolutions, fitCategories, gridHtml, makePuzzle, puzzleFacts } from "../src/hq/puzzles";
import { captionText, chunkSources, docxToText, fetchSource, htmlToText, rankChunks, readZip, youtubeId } from "../src/hq/sources";

function make(over: Record<string, unknown>): Book {
  const b = newBook({ brief: "A book long enough to pass the check.", ...over });
  assert.ok(!("error" in b));
  return b;
}

async function runAll(b: Book, model: BookModel, max = 80): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < max; i++) {
    const step = nextStep(b);
    if (!step) break;
    await runStep(b, step, model, new AbortController().signal);
    settle(b);
    done.push(step.kind + ("n" in step ? step.n : ""));
  }
  return done;
}

// --- Puzzles --------------------------------------------------------------------------

test("Puzzles: every size has exactly one answer, and the same seed makes the same puzzle", async () => {
  for (const type of ["logic", "mystery"] as const)
    for (const d of ["easy", "medium"] as const)
      for (const seed of [1, 2, 3]) {
        const p = await makePuzzle(type, d, [], seed * 1009);
        assert.equal(countSolutions(p.categories.length, p.categories[0].items.length, p.clues, 3), 1, `${type} ${d} ${seed}`);
        // Every clue is needed: dropping any one leaves more than one answer
        for (let i = 0; i < p.clues.length; i++) assert.ok(countSolutions(p.categories.length, p.categories[0].items.length, p.clues.filter((_, j) => j !== i), 2) > 1, "no redundant clues");
      }
  const a = await makePuzzle("mystery", "medium", [], 42);
  const b = await makePuzzle("mystery", "medium", [], 42);
  assert.deepEqual(a, b);
});

test("Puzzles: a whodunit's culprit had the crime's place and weapon; the story writer never learns who", async () => {
  const p = await makePuzzle("mystery", "medium", [{ name: "Suspect", items: ["Ada", "Bram", "Cleo", "Dev"] }, { name: "Place", items: ["the Pier", "the Bar", "the Lift", "the Roof"] }, { name: "Item", items: ["the oar", "the rope", "the vase", "the pen"] }], 7, {
    victim: "Mr Gold",
    roles: ["the cook", "a guest", "the porter", "the owner"],
  });
  assert.deepEqual(p.categories.map((c) => c.name), ["Suspect", "Place", "Item", "Time"], "medium adds an ordered category");
  const rows = answerRows(p);
  const culprit = rows[p.crime!.culprit];
  assert.equal(culprit[1], p.categories[1].items[p.crime!.place]);
  assert.equal(culprit[2], p.categories[2].items[p.crime!.item]);
  const facts = puzzleFacts(p);
  assert.match(facts, /Suspects: Ada, Bram, Cleo, Dev/);
  assert.match(facts, /Mr Gold was found in/);
  assert.match(facts, /Ada \(the cook\)/);
  assert.ok(!/did it|culprit/i.test(facts));
  // Clues read as English
  const words = p.clues.map((c) => clueText(p, c));
  assert.ok(words.every((w) => /^[A-Z].*\.$/.test(w)));
  assert.ok(words.some((w) => /the suspect who (was in|had|arrived at)/.test(w) || /^(Ada|Bram|Cleo|Dev) /.test(w)));
});

test("Puzzles: unusable categories from the model are replaced; the grid has one block per pair", () => {
  const cats = fitCategories("logic", "hard", [{ name: "Person", items: ["A", "B"] }, { name: "Pet", verb: "owns", items: ["cat", "cat", "dog", "eel", "fox"] }], 3);
  assert.equal(cats.length, 4);
  assert.equal(cats[0].items.length, 5, "too few people: built-in names");
  assert.ok(!cats.some((c) => c.items.includes("eel")), "a category with repeats is dropped");
  assert.ok(cats.every((c) => new Set(c.items).size === c.items.length));
  assert.ok(cats[3].ordinal);
  const mystery = fitCategories("mystery", "easy", [], 1);
  assert.deepEqual(mystery.map((c) => c.name), ["Suspect", "Room", "Item"], "places, then items, always");
});

test("Puzzles: the solving grid", async () => {
  const p = await makePuzzle("logic", "medium", [], 5);
  const html = gridHtml(p);
  // 4 categories × 4 items: cells for people×3 categories, plus 2 + 1 lower blocks
  const cells = (html.match(/<td>/g) ?? []).length;
  assert.equal(cells, 4 * 4 * 3 + 4 * 4 * 2 + 4 * 4 * 1);
  assert.ok(!html.includes("<td/>") && html.startsWith('<table class="grid">'));
});

// --- Sources ----------------------------------------------------------------------------

test("Sources: readable text from a web page, without its menus and scripts", () => {
  const page = `<html><head><title>My Post | Blog</title><script>var x = "<p>no</p>";</script></head><body>
    <nav><a>Home</a><a>About</a></nav><header>Site name</header>
    <article><h1>Bread at home</h1><p>Flour, water &amp; salt. ${"Knead it well. ".repeat(40)}</p><ul><li>Mix</li><li>Rest</li></ul></article>
    <aside>Subscribe!</aside><footer>© me</footer></body></html>`;
  const out = htmlToText(page);
  assert.equal(out.title, "My Post | Blog");
  assert.match(out.text, /^## Bread at home\n\nFlour, water & salt\./);
  assert.match(out.text, /- Mix\n- Rest/);
  assert.ok(!/Home|Subscribe|Site name|var x|© me/.test(out.text));
});

test("Sources: Word documents keep headings and lists", () => {
  const xml =
    `<?xml version="1.0"?><w:document><w:body>` +
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Getting started</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t xml:space="preserve">Buy a </w:t></w:r><w:r><w:t>scale &amp; a bowl.</w:t></w:r></w:p>` +
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Flour</w:t></w:r></w:p><w:p/>` +
    `</w:body></w:document>`;
  const docx = zip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from(xml) },
  ]);
  assert.equal(readZip(docx).get("word/document.xml")?.toString(), xml);
  assert.equal(docxToText(docx), "## Getting started\n\nBuy a scale & a bowl.\n\n- Flour");
  assert.throws(() => docxToText(zip([{ name: "x.txt", data: Buffer.from("x") }])), /isn't a Word document/);
});

test("Sources: YouTube links and captions", () => {
  assert.equal(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://example.com/watch?v=x"), null);
  assert.equal(captionText('<transcript><text start="0">Hello &amp;amp; welcome</text><text start="1">to the show</text></transcript>'), "Hello & welcome to the show");
  assert.equal(captionText(JSON.stringify({ events: [{ segs: [{ utf8: "Hi" }, { utf8: " there" }] }, { segs: [{ utf8: "friend" }] }] })), "Hi there friend");
});

test("Sources: fetching checks every address and reads public Google Docs", async () => {
  await assert.rejects(fetchSource("http://127.0.0.1/admin"), /local|private/);
  const calls: string[] = [];
  const fake = (async (url: string) => {
    calls.push(url);
    if (url.includes("redirect")) return new Response("", { status: 302, headers: { location: "http://10.0.0.5/secret" } });
    if (url.includes("docs.google.com")) return new Response("﻿My notes\r\n\r\nLine two", { headers: { "content-type": "text/plain" } });
    return new Response(`<html><title>T</title><body><main><p>${"Real words here. ".repeat(30)}</p></main></body></html>`, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  await assert.rejects(fetchSource("http://1.1.1.1/redirect", { fetchImpl: fake }), /private/, "a redirect to a private address is refused");
  const doc = await fetchSource("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit", { fetchImpl: fake });
  assert.ok("text" in doc && doc.text === "My notes\n\nLine two");
  assert.ok(calls.some((c) => c.endsWith("/export?format=txt")));
  const page = await fetchSource("http://1.1.1.1/post", { fetchImpl: fake });
  assert.ok("text" in page && page.text.startsWith("Real words here."));
});

test("Sources: chunks break at paragraphs, and the best-matching ones are picked", () => {
  const chunks = chunkSources(
    [
      { id: "a", kind: "text", name: "A", text: `Sourdough starter needs feeding daily.\n\n${"Filler about weather. ".repeat(60)}\n\nShaping a boule takes practice.`, addedAt: 0 },
      { id: "b", kind: "text", name: "B", text: "Ovens and baking stones: preheat for an hour.", addedAt: 0 },
    ],
    600,
  );
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[chunks.length - 1].source, "B");
  const best = rankChunks(chunks, "How to feed a sourdough starter", 700);
  assert.equal(best[0].i, 0);
  assert.ok(best.every((c) => /starter/i.test(c.text)));
});

// --- Books from your own content ------------------------------------------------------

function sourceModel() {
  const prompts: ChatMessage[][] = [];
  const model: BookModel = {
    write: async (m) => {
      prompts.push(m);
      const u = m[1].content;
      if (/Note what this part contains/.test(u)) return { text: `Notes: ${/Part (\d+)/.exec(u)?.[1]}`, ref: "f" };
      if (/BOOK PLAN in Markdown/.test(u)) return { text: "## Reader promise\nBake bread." + " plan".repeat(40), ref: "f" };
      if (/Summarize this chapter/.test(u)) return { text: "Covered starters.", ref: "f" };
      return { text: "word ".repeat(1000), ref: "f" };
    },
    json: async (m) => {
      prompts.push(m);
      return { json: { title: "Bread", chapters: [{ title: "Starters", beats: "Feeding a starter.", sources: [1, 99] }, { title: "Ovens", beats: "Preheating." }] }, ref: "f" };
    },
    contextChars: () => 16000,
  };
  return { model, prompts };
}

test("Books: a large source is noted part by part, planned from the notes, and each chapter gets its passages", async () => {
  const b = make({ kind: "ebook", chapterCount: 2, chapterWords: 900 });
  const text = Array.from({ length: 8 }, (_, i) => `Part ${i} talks about ${i === 0 ? "sourdough starter feeding" : i === 7 ? "oven preheating and baking stones" : "assorted things"}. ${"More detail here. ".repeat(110)}`).join("\n\n");
  const added = addSource(b, { kind: "url", name: "My blog", origin: "https://blog", text });
  assert.ok(!("error" in added));
  assert.equal(b.faithful, true, "repurposing stays true to the source by default");
  const { model, prompts } = sourceModel();
  const steps = await runAll(b, model);
  const digests = steps.filter((s) => s.startsWith("digest")).length;
  assert.ok(digests >= 4, `notes on every part (${digests})`);
  assert.deepEqual(steps.slice(digests), ["bible", "outline"]);
  const plan = prompts.find((m) => /BOOK PLAN in Markdown/.test(m[1].content))![1].content;
  assert.match(plan, /SOURCE NOTES[\s\S]*\[Part 1, from My blog\] Notes: 1/);
  assert.match(outlinePrompt(b)[1].content, /"sources": the numbers of the source parts \(1–\d+\)/);
  assert.deepEqual(b.chapters[0].sources, [0], "part numbers out of range are dropped");
  b.stage = "writing";
  const ch1 = chapterPrompt(b, 0, 16000);
  assert.match(ch1[0].content, /Don't add facts, numbers, stories or claims that aren't in it/);
  assert.match(ch1[1].content, /SOURCE MATERIAL FOR THIS CHAPTER:\n\[from My blog\]\nPart 0 talks about sourdough starter feeding/);
  // Chapter 2 named no parts: the best match is found by its words
  assert.match(chapterSources(b, 1, 6000), /oven preheating/);
  assert.ok(removeSource(b, (added as { id: string }).id));
  assert.equal(b.chapters[0].sources, undefined);
});

test("Books: a short source is used whole, with no notes step", async () => {
  const b = make({ kind: "ebook", chapterCount: 2 });
  addSource(b, { kind: "text", name: "Notes", text: "Short notes about kneading dough by hand, ten minutes, until smooth and elastic." });
  assert.deepEqual(nextStep(b), { kind: "bible" });
  const { model, prompts } = sourceModel();
  await runStep(b, { kind: "bible" }, model, new AbortController().signal);
  assert.match(prompts[0][1].content, /SOURCE MATERIAL \(the author's own content[\s\S]*\[Source 1: Notes\]\nShort notes about kneading/);
  assert.deepEqual(addSource(b, { kind: "text", name: "x", text: "tiny" }), { error: "That source had almost no text" });
});

// --- Picture books ----------------------------------------------------------------------

function pictureModel() {
  const pictures: { prompt: string; seed: number; size: string }[] = [];
  const model: BookModel = {
    write: async () => ({ text: "Pip smiled at the moon.", ref: "f" }),
    json: async (m) => {
      if (/Plan the book as/.test(m[1].content))
        return { json: { title: "Pip and the Fireflies", logline: "A hedgehog learns the dark is friendly.", lesson: "Bravery", characters: [{ name: "Pip", look: "a small round hedgehog with a red scarf" }], style: "soft watercolour" }, ref: "f" };
      return { json: { pages: [{ text: "Pip was scared of the dark.", picture: "Pip hiding under a leaf at dusk" }, { text: "Then the fireflies came.", picture: "Fireflies circling Pip" }] }, ref: "f" };
    },
    contextChars: () => 16000,
    illustrate: async (prompt, seed, size) => {
      pictures.push({ prompt, seed, size });
      return { name: `book-page-0000000${pictures.length}.png` };
    },
  };
  return { model, pictures };
}

test("Picture books: characters planned once, pages written with the story, one consistent picture per page", async () => {
  const b = make({ kind: "picture", chapterCount: 2, artStyle: "gentle crayon" });
  assert.equal(b.chapterWords, 40);
  const { model, pictures } = pictureModel();
  assert.deepEqual(await runAll(b, model), ["bible", "outline"]);
  assert.equal(b.title, "Pip and the Fireflies");
  assert.equal(b.art!.style, "gentle crayon", "your style wins over the model's");
  assert.equal(b.art!.characters, "Pip: a small round hedgehog with a red scarf");
  assert.match(b.bible, /## Characters\n- \*\*Pip\*\* — a small round hedgehog/);
  assert.deepEqual(b.chapters.map((c) => [c.title, c.text]), [
    ["Page 1", "Pip was scared of the dark."],
    ["Page 2", "Then the fireflies came."],
  ]);
  b.stage = "writing";
  assert.deepEqual(await runAll(b, model), ["illustrate0", "illustrate1"], "text came with the outline: only pictures are left");
  assert.equal(b.stage, "done");
  assert.equal(new Set(pictures.map((p) => p.seed)).size, 1, "one seed for the whole book");
  assert.ok(pictures.every((p) => p.size === "square" && p.prompt.startsWith("gentle crayon. Pip: a small round hedgehog with a red scarf. Scene: ") && /No text/.test(p.prompt)));
  // Draw a page again
  assert.equal(rewriteChapter(b, 1, undefined, "picture"), null);
  assert.deepEqual(nextStep(b), { kind: "illustrate", n: 1 });
  assert.equal(b.chapters[1].text, "Then the fireflies came.", "the text is kept");
  // With pictures off, the book is done without them
  b.art!.off = true;
  settle(b);
  assert.equal(b.stage, "done");
});

test("Picture books: a missing picture tool pauses with a reason", async () => {
  const b = make({ kind: "picture", chapterCount: 1 });
  b.bible = "x";
  b.stage = "writing";
  b.chapters = [{ title: "Page 1", beats: "A cat", text: "Hi." }];
  const { model } = pictureModel();
  delete model.illustrate;
  await assert.rejects(runStep(b, nextStep(b)!, model, new AbortController().signal), /Pictures need the tools service/);
});

test("Picture books: print layout, KDP bleed and padding, EPUB with the pictures", () => {
  const b = make({ kind: "picture", title: "Pip" });
  b.chapters = [
    { title: "Page 1", beats: "a", text: "One.", image: "book-page-aaaaaaaa.png" },
    { title: "Page 2", beats: "b", text: "Two." },
  ];
  const html = bookHtml(b, { kdp: { pages: 4, padTo: 24 }, image: (n) => (n.includes("aaaa") ? "data:image/png;base64,AAAA" : null) });
  assert.match(html, /@page \{ size: 8\.625in 8\.75in; margin: 0; \}/, "bleed: 0.125 in wider, 0.25 in taller");
  assert.match(html, /<div class="pp"><img src="data:image\/png;base64,AAAA" alt=""><div class="txt">One\.<\/div><\/div>/);
  assert.match(html, /<div class="noimg"><\/div><div class="txt">Two\./);
  assert.match(html, /This book belongs to/);
  assert.equal((html.match(/<div class="blank"><\/div>/g) ?? []).length, 19, "20 pages of padding: one 'belongs to' and 19 blank");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const files = unzip(bookEpub(b, undefined, (n) => (n.includes("aaaa") ? { data: png, mime: "image/png" } : null)));
  assert.ok(files.some((f) => f.name === "OEBPS/images/page-1.png"));
  assert.match(files.find((f) => f.name === "OEBPS/content.opf")!.data.toString(), /href="images\/page-1.png" media-type="image\/png"/);
  assert.match(files.find((f) => f.name === "OEBPS/chapter-001.xhtml")!.data.toString(), /<img src="images\/page-1.png" alt="a"\/><\/div><p class="page-text">One\.<\/p>/);
  assert.match(bookMarkdown(b), /## Page 2\n\nTwo\.\n\n\*\[Picture: b\]\*/);
});

// --- Puzzle books ---------------------------------------------------------------------

test("Puzzle books: puzzles are built from the model's names, stories never see the answer, answers go at the back", async () => {
  const b = make({ kind: "puzzle", chapterCount: 2, difficulty: "easy", title: "Hotel Mysteries" });
  const prompts: string[] = [];
  const model: BookModel = {
    write: async (m) => {
      prompts.push(m[1].content);
      return { text: /BOOK PLAN in Markdown/.test(m[1].content) ? "## Theme\nA hotel." + " x".repeat(60) : "The storm cut the power at the Grand. " + "Everyone had a reason to hate him. ".repeat(10), ref: "f" };
    },
    json: async () => ({
      json: {
        puzzles: [
          { title: "Death in the Lift", setting: "A stuck lift", victim: "Lord Ashby, the owner", suspects: [{ name: "Ada", role: "the cook" }, { name: "Bram", role: "a guest" }, { name: "Cleo", role: "the porter" }, { name: "Dev", role: "the maid" }], places: ["the Lift", "the Bar", "the Roof", "the Spa"], items: ["the oar", "the rope", "the vase", "the pen"] },
          { title: "Bad suspects", suspects: [{ name: "Only one" }] },
        ],
      },
      ref: "f",
    }),
    contextChars: () => 16000,
  };
  assert.deepEqual(await runAll(b, model), ["bible", "outline"]);
  assert.equal(b.chapters.length, 2);
  const p = b.chapters[0].puzzle!;
  assert.deepEqual(p.categories[0].items, ["Ada", "Bram", "Cleo", "Dev"]);
  assert.deepEqual(p.roles, ["the cook", "a guest", "the porter", "the maid"]);
  assert.equal(p.crime!.victim, "Lord Ashby, the owner");
  assert.equal(b.chapters[1].puzzle!.categories[0].items.length, 4, "unusable suspects: built-in names");
  b.stage = "writing";
  assert.deepEqual(await runAll(b, model), ["chapter0", "chapter1"], "one story per puzzle, no summaries");
  const story = prompts.find((x) => x.startsWith("PUZZLE 1"))!;
  const culprit = p.categories[0].items[p.crime!.culprit];
  assert.ok(!story.includes(`${culprit} did it`) && !/culprit|answer/i.test(story));
  assert.ok(!p.clues.some((c) => story.includes(clueText(p, c))), "the clues aren't in the story prompt either");
  const html = bookHtml(b);
  assert.match(html, /@page \{ size: 8\.5in 11in;/, "puzzle books default to 8.5×11");
  assert.match(html, /<span class="num">Puzzle 1<\/span>Death in the Lift/);
  assert.match(html, /<h3>Clues<\/h3><ol class="clues">/);
  assert.match(html, /<h1>Answer key<\/h1>[\s\S]*<strong>[A-Za-z ]+ did it<\/strong>/);
  assert.ok(html.indexOf("Answer key</h1>") > html.lastIndexOf('<table class="grid">'), "answers come after every puzzle");
  assert.match(bookMarkdown(b), /## Answer key\n\n### 1\. Death in the Lift\n\n\*\*\w+ did it\.\*\*/);
  // A new puzzle for the same scene: same people, new clues
  const oldClues = JSON.stringify(p.clues);
  assert.equal(rewriteChapter(b, 0, undefined, "puzzle"), null);
  await runStep(b, nextStep(b)!, model, new AbortController().signal);
  assert.deepEqual(b.chapters[0].puzzle!.categories[0].items, ["Ada", "Bram", "Cleo", "Dev"]);
  assert.notEqual(JSON.stringify(b.chapters[0].puzzle!.clues), oldClues);
});

// --- KDP -------------------------------------------------------------------------------

test("KDP: gutter by page count, spine and cover size by paper", () => {
  assert.deepEqual([24, 150, 151, 300, 301, 500, 700, 828].map(gutterFor), [0.375, 0.375, 0.5, 0.5, 0.625, 0.625, 0.75, 0.875]);
  const s = coverSpec("6x9", 300, "white");
  assert.equal(s.spine, 0.676);
  assert.equal(s.width, 12.926);
  assert.equal(s.height, 9.25);
  assert.equal(s.spineText, true);
  assert.deepEqual(s.pixels, [3878, 2775]);
  assert.equal(coverSpec("6x9", 300, "cream").spine, 0.75);
  assert.equal(coverSpec("8.5x8.5", 24, "color").spineText, false);
  const css = interiorPageCss("6x9", 320);
  assert.match(css, /@page :right \{ margin-left: 0\.625in; margin-right: 0\.5in; \}/);
  assert.match(css, /@page :left \{ margin-left: 0\.5in; margin-right: 0\.625in; \}/);
  const cover = coverHtml(s, { title: "Tide & Time", author: "M. Keeper", blurb: "First para.\n\nSecond <b>para</b>." });
  assert.match(cover, /@page \{ size: 12\.926in 9\.25in; margin: 0; \}/);
  assert.match(cover, /class="barcode"/);
  assert.match(cover, /<p>Second &lt;b&gt;para&lt;\/b&gt;\.<\/p>/);
  assert.match(cover, new RegExp(`\\.spine \\{ left: ${BLEED + 6}in; width: 0\\.676in;`));
  assert.match(cover, /class="spine-text"[^>]*>Tide &amp; Time<span> · M\. Keeper/);
});

test("KDP: listings keep only the HTML KDP accepts and drop banned keywords", () => {
  assert.equal(cleanDescription('<p class="x" onclick="evil()">Hi <a href="x">there</a><script>bad()</script></p><img src=x>'), "<p>Hi there</p>");
  const l = parseListing({
    description: `<p>${"Learn to bake real bread at home. ".repeat(5)}</p>`,
    backCover: "Back.",
    keywords: ["sourdough for beginners", "free bread book", "Bestseller baking", "artisan bread", 5],
    categories: ["Cookbooks › Baking › Bread"],
  });
  assert.ok(!("error" in l));
  assert.deepEqual(l.keywords, ["sourdough for beginners", "artisan bread"]);
  assert.deepEqual(parseListing({ description: "<p>short</p>" }), { error: "The listing had no usable description" });
});

test("Books: a listing kit runs as the next step and doesn't reopen a finished book", async () => {
  const b = make({ kind: "ebook" });
  b.bible = "## Plan";
  b.stage = "done";
  b.chapters = [{ title: "A", beats: "", text: "x", summary: "s", words: 1 }];
  b.wantListing = true;
  assert.deepEqual(nextStep(b), { kind: "listing" });
  const model: BookModel = {
    write: async () => ({ text: "", ref: "f" }),
    json: async () => ({ json: { description: `<p>${"A clear, honest description. ".repeat(6)}</p>`, backCover: "Back", keywords: ["a b"], categories: [] }, ref: "f" }),
    contextChars: () => 16000,
  };
  await runStep(b, { kind: "listing" }, model, new AbortController().signal);
  settle(b);
  assert.equal(b.stage, "done");
  assert.equal(b.wantListing, undefined);
  assert.deepEqual(b.listing?.keywords, ["a b"]);
  assert.equal(nextStep(b), null);
});
