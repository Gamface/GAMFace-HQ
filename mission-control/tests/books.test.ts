// Tests for Books (novels and ebooks) and the EPUB writer.   npm test
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BookStore,
  bookEpub,
  bookHtml,
  bookMarkdown,
  chapterPrompt,
  cleanChapter,
  countWords,
  editBook,
  failed,
  newBook,
  nextStep,
  parseOutline,
  rewriteChapter,
  runStep,
  settle,
} from "../src/hq/books";
import type { Book, BookModel } from "../src/hq/books";
import { toXhtml, unzip, zip } from "../src/hq/epub";
import type { ChatMessage } from "../src/hq/ollama";

const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ") + ".";

function book(over: Record<string, unknown> = {}): Book {
  const b = newBook({ brief: "A lighthouse keeper finds a message in a bottle from her future self.", chapterCount: 3, chapterWords: 400, ...over });
  assert.ok(!("error" in b));
  return b;
}

/** A scripted model: records what it was asked, answers by the kind of prompt. */
function fakeModel(opts: { chapterWords?: number; budget?: number } = {}) {
  const calls: { kind: string; messages: ChatMessage[] }[] = [];
  const model: BookModel = {
    async write(messages, _signal, onToken) {
      const u = messages[messages.length - 1].content;
      const kind = /STORY BIBLE in Markdown|BOOK PLAN in Markdown/.test(u) ? "bible" : /^CHAPTER \d+:.*\n\n[\s\S]*Summarize/.test(u) ? "summary" : /Continue the chapter/.test(u) ? "continue" : "chapter";
      calls.push({ kind, messages });
      const text =
        kind === "bible"
          ? "## Logline\nMara keeps the light.\n## Characters\nMara — keeper. Theo — the ferryman.\n## Style guide\nThird person, past tense.\n## Arc\nShe saves the ship." + " detail".repeat(30)
          : kind === "summary"
            ? "Mara found the bottle; Theo doubts her."
            : kind === "continue"
              ? words(200, "more")
              : `# Chapter 1: Ignored heading\n\n${words(opts.chapterWords ?? 400)}`;
      onToken(text);
      return { text, ref: "fake/model" };
    },
    async json(messages) {
      calls.push({ kind: "outline", messages });
      return {
        json: { title: "The Keeper's Letter", chapters: [{ title: "Chapter 1: The Bottle", beats: "She finds it." }, { title: "Storm", beats: ["The storm", "comes."] }, { title: "Light", beats: "She lights the lamp." }] },
        ref: "fake/model",
      };
    },
    contextChars: () => opts.budget ?? 16000,
  };
  return { model, calls };
}

async function runAll(b: Book, model: BookModel, max = 50): Promise<string[]> {
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

test("Books: a new book needs a brief and gets sensible defaults", () => {
  assert.deepEqual(newBook({ brief: "short" }), { error: "Describe the story you want (a sentence or two at least)" });
  const novel = book({ chapterCount: 999, chapterWords: 5 });
  assert.equal(novel.kind, "novel");
  assert.equal(novel.chapterCount, 60, "capped at 60 chapters");
  assert.equal(novel.chapterWords, 300, "at least 300 words a chapter");
  assert.equal(novel.stage, "planning");
  assert.equal(novel.author, "Anonymous");
  assert.match(novel.uuid, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  const ebook = newBook({ kind: "ebook", brief: "A beginner's guide to sourdough baking at home", project: "general" });
  assert.ok(!("error" in ebook));
  assert.equal(ebook.chapterCount, 10);
  assert.equal(ebook.project, null, "General is no project");
  assert.equal((newBook({ brief: "A long enough brief here", start: false }) as Book).paused, true, "can be created paused");
});

test("Books: plans, waits for approval, then writes, continues short chapters and summarizes in order", async () => {
  const b = book();
  const { model, calls } = fakeModel({ chapterWords: 150 });
  assert.deepEqual(await runAll(b, model), ["bible", "outline"]);
  assert.equal(b.stage, "review", "stops for you to check the outline");
  assert.equal(b.title, "The Keeper's Letter", "takes the outline's title when there was none");
  assert.deepEqual(
    b.chapters.map((c) => [c.title, c.beats]),
    [
      ["The Bottle", "She finds it."],
      ["Storm", "The storm comes."],
      ["Light", "She lights the lamp."],
    ],
  );
  assert.equal(nextStep(b), null, "nothing runs until it's approved");

  b.stage = "writing";
  const steps = await runAll(b, model);
  // 150 words is under 60% of 400, so each chapter gets one "keep going" (to 350 words) before its summary
  assert.deepEqual(steps, ["chapter0", "continue0", "summary0", "chapter1", "continue1", "summary1", "chapter2", "continue2", "summary2"]);
  assert.equal(b.stage, "done");
  assert.ok(b.chapters.every((c) => c.summary && c.words === 350 && c.parts === 2));
  assert.ok(!b.chapters[0].text!.includes("Ignored heading"), "the model's own heading is removed");

  // Chapter 3's prompt carries the outline, the story so far and the end of chapter 2
  const third = calls.filter((c) => c.kind === "chapter")[2].messages;
  assert.match(third[0].content, /STORY BIBLE — The Keeper's Letter:\n## Logline/);
  assert.match(third[1].content, /OUTLINE:\n1\. The Bottle/);
  assert.match(third[1].content, /STORY SO FAR:\nChapter 1 \(The Bottle\): Mara found the bottle/);
  assert.match(third[1].content, /END OF CHAPTER 2:\n…/);
  assert.match(third[1].content, /NOW WRITE CHAPTER 3: Light\nBeats: She lights the lamp\.[\s\S]*final chapter/);
});

test("Books: a model that stops short only gets three tries, and one with nothing to add ends the chapter", async () => {
  const b = book({ chapterCount: 1 });
  b.bible = "x".repeat(200);
  b.chapters = [{ title: "One", beats: "Things happen." }];
  b.stage = "writing";
  let calls = 0;
  const model: BookModel = {
    write: async (m) => {
      calls++;
      return { text: /Continue/.test(m[1].content) ? "Done." : words(100), ref: "f" };
    },
    json: async () => ({ json: {}, ref: "f" }),
    contextChars: () => 16000,
  };
  await runAll(b, model);
  assert.equal(calls, 3, "chapter, one continue that added nothing, summary");
  assert.equal(b.chapters[0].words, 100);
  assert.equal(b.stage, "done");
});

test("Books: the chapter prompt shrinks to fit a small context", () => {
  const b = book({ chapterCount: 30, chapterWords: 3000 });
  b.bible = "Bible. ".repeat(200);
  b.stage = "writing";
  b.chapters = Array.from({ length: 30 }, (_, i) => ({
    title: `Chapter title ${i + 1}`,
    beats: `Long beats for chapter ${i + 1}. `.repeat(10),
    ...(i < 25 ? { text: words(2500), summary: `Summary of ${i + 1}. It has a second sentence that gets cut. `.repeat(3), words: 2500, parts: 1 } : {}),
  }));
  const big = chapterPrompt(b, 25, 200_000);
  assert.match(big[1].content, /1\. Chapter title 1 — Long beats/, "with room, every chapter has its beats");
  const small = chapterPrompt(b, 25, 6500);
  const size = small[0].content.length + small[1].content.length;
  assert.ok(size <= 6500, `fits: ${size}`);
  assert.match(small[1].content, /^1\. Chapter title 1$/m, "far chapters by title only");
  assert.match(small[1].content, /25\. Chapter title 25 — Long beats/, "near chapters keep their beats");
  assert.match(small[1].content, /Chapters 1–19 happened earlier/, "oldest summaries dropped");
  assert.match(small[1].content, /NOW WRITE CHAPTER 26/);
});

test("Books: outlines from sloppy JSON are still usable", () => {
  const out = parseOutline({ outline: ["Opening", { name: "Chapter 2 - Middle", summary: "Stuff." }, {}, { title: "End", beats: "Bye." }] }, 2);
  assert.ok(!("error" in out));
  assert.deepEqual(
    out.chapters.map((c) => c.title),
    ["Opening", "Middle"],
    "cut to the length asked for",
  );
  assert.deepEqual(parseOutline({ chapters: [] }, 3), { error: "The outline had no chapters" });
});

test("Books: chatter, thinking and repeated headings are cleaned from chapters", () => {
  assert.equal(cleanChapter("<think>plan</think>Here is Chapter 2:\n\n## Chapter 2: Storm\n\nRain fell.\n\n(End of chapter 2)", "Storm"), "Rain fell.");
  assert.equal(cleanChapter("```markdown\n**Chapter Two**\nRain fell.\n```", "Storm"), "Rain fell.");
  assert.equal(cleanChapter("## Storm\n\nRain fell.", "Storm"), "Rain fell.");
  assert.equal(cleanChapter("## The harbour\n\nRain fell.", "Storm"), "## The harbour\n\nRain fell.", "a real subheading stays");
});

test("Books: editing the outline keeps written text by index; hand-edited text is summarized again", () => {
  const b = book();
  b.stage = "writing";
  b.chapters = [
    { title: "A", beats: "a", text: words(400), words: 401, summary: "sa", parts: 1 },
    { title: "B", beats: "b", text: words(400), words: 401, summary: "sb", parts: 1 },
  ];
  assert.equal(editBook(b, { chapters: [{ from: 1, title: "B2" }, { from: 0, text: "Rewritten by hand with enough words." }, { title: "New", beats: "c" }] }), null);
  assert.deepEqual(
    b.chapters.map((c) => [c.title, c.summary ?? null, c.words ?? null]),
    [
      ["B2", "sb", 401],
      ["A", null, 6],
      ["New", null, null],
    ],
  );
  assert.equal(b.chapterCount, 3);
  assert.deepEqual(nextStep(b), { kind: "summary", n: 1 }, "a hand edit is never 'kept going', only summarized");
  assert.equal(editBook(b, { chapters: [] }), "A book needs at least one chapter");
  assert.equal(editBook(b, { brief: "no" }), "The brief is too short");
});

test("Books: rewriting a chapter clears it with your note; failures pause after two tries", () => {
  const b = book();
  assert.equal(rewriteChapter(b, 0), "No such chapter");
  b.chapters = [{ title: "A", beats: "a", text: "x", summary: "s", words: 1 }];
  assert.equal(rewriteChapter(b, 0), "Approve the outline first");
  b.stage = "done";
  assert.equal(rewriteChapter(b, 0, "more dialogue"), null);
  assert.deepEqual(b.chapters[0], { title: "A", beats: "a", note: "more dialogue" });
  assert.equal(b.stage, "writing");
  failed(b, "model down");
  assert.ok(!b.paused, "one failure is retried");
  failed(b, "model down");
  assert.equal(b.paused, true);
  assert.equal(nextStep(b), null);
});

test("Books: the store saves each book and picks the most recent one to work on", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "books-"));
  const store = new BookStore(dir);
  const a = book();
  const b = book({ title: "Second" });
  store.save(a);
  await new Promise((r) => setTimeout(r, 5));
  store.save(b);
  assert.equal(store.next()?.book.id, b.id);
  b.paused = true;
  store.save(b);
  assert.equal(store.next()?.book.id, a.id, "a paused book is skipped");
  const again = new BookStore(dir);
  assert.equal(again.list().length, 2);
  assert.equal(again.get(b.id)?.title, "Second");
  assert.equal(again.get("../etc"), undefined);
  assert.ok(again.delete(a.id));
  assert.equal(new BookStore(dir).list().length, 1);
});

test("EPUB: a valid package with the mimetype first and stored, chapters as XHTML, and a cover", () => {
  const b = book({ title: "Tide & Time", author: "M. <Keeper>" });
  b.chapters = [
    { title: "One", beats: "", text: "First *line*.\n\n***\n\nAfter the break.\n\n## A subheading\n\nMore.", words: 7 },
    { title: "Two", beats: "" },
  ];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const entries = unzip(bookEpub(b, { data: png, mime: "image/png" }));
  assert.equal(entries[0].name, "mimetype");
  assert.equal(entries[0].stored, true);
  assert.equal(entries[0].data.toString(), "application/epub+zip");
  const get = (n: string) => entries.find((e) => e.name === n)?.data.toString() ?? "";
  assert.match(get("META-INF/container.xml"), /full-path="OEBPS\/content.opf"/);
  const opf = get("OEBPS/content.opf");
  assert.match(opf, /<dc:title>Tide &amp; Time<\/dc:title>/);
  assert.match(opf, /<dc:creator>M\. &lt;Keeper&gt;<\/dc:creator>/);
  assert.match(opf, new RegExp(`urn:uuid:${b.uuid}`));
  assert.match(opf, /properties="cover-image"/);
  assert.match(opf, /<itemref idref="ch1"\/>/);
  assert.ok(!opf.includes('idref="ch2"'), "unwritten chapters are left out");
  const ch = get("OEBPS/chapter-001.xhtml");
  assert.match(ch, /<h1><span class="num">Chapter 1<\/span>One<\/h1>/);
  assert.match(ch, /<em>line<\/em>/);
  assert.match(ch, /<hr\/>/, "*** is a scene break, closed for XHTML");
  assert.match(ch, /<h3>A subheading<\/h3>/, "headings sit under the chapter title");
  assert.match(get("OEBPS/nav.xhtml"), /<a href="chapter-001.xhtml">Chapter 1: One<\/a>/);
  assert.match(get("OEBPS/toc.ncx"), /<navPoint id="np1" playOrder="1">/);
  assert.ok(entries.some((e) => e.name === "OEBPS/cover.png" && e.data.equals(png)));
});

test("EPUB: zip round-trips and XHTML fixes void tags and stray ampersands", () => {
  const z = unzip(zip([{ name: "a.txt", data: Buffer.from("hello hello hello") }, { name: "ü.txt", data: Buffer.from("x"), compress: false }]));
  assert.deepEqual(
    z.map((e) => [e.name, e.data.toString()]),
    [
      ["a.txt", "hello hello hello"],
      ["ü.txt", "x"],
    ],
  );
  assert.equal(toXhtml('<p>A &amp; B & C&nbsp;</p><hr><img src="x" alt="y">'), '<p>A &amp; B &amp; C&#160;</p><hr/><img src="x" alt="y"/>');
});

test("Books: Markdown and print HTML exports", () => {
  const b = book({ title: "T", kind: "ebook" });
  b.chapters = [{ title: "Basics", beats: "", text: "# Why\n\nBecause." }];
  assert.equal(bookMarkdown(b), "# T\n\nby Anonymous\n\n## Basics\n\n# Why\n\nBecause.\n");
  const html = bookHtml(b, { trim: "5x8" });
  assert.match(html, /@page \{ size: 5in 8in;/);
  assert.match(html, /<section class="chapter"><h1>Basics<\/h1><h2>Why<\/h2>/, "ebooks have no 'Chapter n' label");
  assert.ok(!html.includes('class="toc"'), "no contents page for one chapter");
  assert.equal(countWords("  one two\nthree "), 3);
});
