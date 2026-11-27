// Tests for AI cover art (the art brief, drawing options in the background) and cover
// typography (embedded font pairs and front-cover layouts).   npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { coverDesignFor, describeStep, newBook, nextStep, requestCoverArt, runStep, setCoverDesign, stopCoverArt } from "../src/hq/books";
import type { Book, BookModel } from "../src/hq/books";
import { COVER_STYLES, NO_TEXT, colourName, coverBriefPrompt, fallbackBrief, finishPrompt, parseCoverBrief, printPixels } from "../src/hq/coverart";
import { FONT_PAIRS, LAYOUTS, fontCss, fontPairById } from "../src/hq/coverfonts";
import { coverHtml, coverSpec, ebookCoverHtml } from "../src/hq/kdp";

function make(over: Record<string, unknown> = {}): Book {
  const b = newBook({ brief: "A lighthouse keeper finds a message in a bottle during a storm.", genre: "Literary fiction", ...over });
  assert.ok(!("error" in b));
  return b;
}

const signal = () => new AbortController().signal;

function model(over: Partial<BookModel> = {}): BookModel & { drawn: string[] } {
  const drawn: string[] = [];
  return {
    drawn,
    write: async () => ({ text: "", ref: "f" }),
    json: async () => ({ json: { prompt: "A lone lighthouse on black rocks in a violent storm at night, a single beam cutting through rain, huge waves, painterly", concept: "Light against the storm" }, ref: "f" }),
    contextChars: () => 16000,
    coverPicture: async (prompt) => {
      drawn.push(prompt);
      return { name: `book-cover-option-${String(drawn.length).padStart(8, "0")}.png` };
    },
    ...over,
  };
}

// --- The brief ----------------------------------------------------------------------------------

test("Cover art: the brief asks for one image, no text, room for the type, and the book's colours", () => {
  const b = make({ title: "The Keeper" });
  const msgs = coverBriefPrompt(b, { style: "painted", note: "a red door", layout: "top", colors: { bg: "#123c4a", fg: "#ffffff", accent: "#e8a33d" } });
  const all = msgs.map((m) => m.content).join("\n");
  assert.match(all, /The Keeper/);
  assert.match(all, /painterly brushwork/);
  assert.match(all, /a red door/);
  assert.match(all, /upper third calm/);
  assert.match(all, /deep teal and amber/);
  assert.match(all, /any text, letters/);
  // Picture books carry their art style and characters
  const pb = make({ kind: "picture" });
  pb.art = { style: "soft gouache", characters: "Pip, a small grey mouse in a yellow scarf", seed: 1 };
  assert.match(coverBriefPrompt(pb, { style: "auto" }).map((m) => m.content).join(""), /Pip, a small grey mouse/);
  assert.equal(COVER_STYLES.length >= 9, true);
});

test("Cover art: replies are checked and every prompt forbids lettering", () => {
  const ok = parseCoverBrief({ prompt: "A lone lighthouse on black rocks in a storm at night, beam through rain", concept: "Light vs storm" });
  assert.ok(!("error" in ok));
  assert.ok(ok.prompt.includes(NO_TEXT));
  assert.deepEqual(parseCoverBrief({ prompt: "lighthouse" }), { error: "The art brief came back empty" });
  // Long prompts fit the picture tool's limit
  assert.ok(finishPrompt("word ".repeat(600)).length <= 1490);
  // A prompt that already says "no text" isn't given it twice
  assert.equal(finishPrompt("A fox in snow, no text, empty sky at the top").split("No text").length, 1);
  const fb = fallbackBrief(make(), { style: "photo", layout: "bands" });
  assert.match(fb, /lighthouse keeper/);
  assert.match(fb, /photorealistic/);
  assert.match(fb, /No text/);
  assert.equal(colourName("#000000"), "black");
  assert.equal(colourName("#ffffff"), "white");
  assert.equal(colourName("#c1121f"), "red");
  assert.equal(colourName("#5b1f2a"), "dark red");
  assert.equal(colourName("#2a0f0f"), "deep red");
  assert.equal(colourName("#1238c9"), "blue");
  assert.deepEqual(printPixels([6, 9]), [1838, 2775]);
  assert.deepEqual(printPixels([8.5, 11]), [2588, 3375]);
});

// --- Drawing in the background ---------------------------------------------------------------------

test("Cover art: the Writer writes the brief, then each option is one step, even while the book is paused", async () => {
  const b = make({ start: false });
  assert.equal(b.paused, true);
  assert.equal(nextStep(b), null);
  assert.equal(requestCoverArt(b, { style: "painted", count: 2, note: "storm", useColors: true }), null);
  assert.deepEqual(nextStep(b), { kind: "coverBrief" });
  assert.equal(describeStep(b, { kind: "coverBrief" }), "Writing the cover art brief");
  const m = model();
  await runStep(b, { kind: "coverBrief" }, m, signal());
  assert.match(b.coverArt!.prompt!, /lighthouse on black rocks/);
  assert.equal(b.coverArt!.concept, "Light against the storm");
  assert.deepEqual(nextStep(b), { kind: "coverArt" });
  assert.equal(describeStep(b, { kind: "coverArt" }), "Drawing cover option 1 of 2");
  await runStep(b, { kind: "coverArt" }, m, signal());
  assert.equal(describeStep(b, { kind: "coverArt" }), "Drawing cover option 2 of 2");
  await runStep(b, { kind: "coverArt" }, m, signal());
  assert.equal(b.coverArt!.options.length, 2);
  assert.notEqual(b.coverArt!.options[0].seed, b.coverArt!.options[1].seed);
  assert.equal(nextStep(b), null);
  // Asking again for the same thing draws more from the same brief, keeping the first two
  requestCoverArt(b, { style: "painted", count: 1, note: "storm", useColors: true });
  assert.deepEqual(nextStep(b), { kind: "coverArt" });
  await runStep(b, { kind: "coverArt" }, m, signal());
  assert.equal(b.coverArt!.options.length, 3);
  // A different style gets a new brief
  requestCoverArt(b, { style: "graphic", count: 1 });
  assert.deepEqual(nextStep(b), { kind: "coverBrief" });
});

test("Cover art: your own prompt is drawn as written; a Writer that fails gets a quick brief", async () => {
  const b = make();
  assert.equal(requestCoverArt(b, { prompt: "too short" }), "Describe the picture in a few more words");
  assert.equal(requestCoverArt(b, { style: "nope" }), "Unknown cover style");
  requestCoverArt(b, { prompt: "A brass compass on a weathered sea chart, warm candlelight", count: 1 });
  assert.equal(b.coverArt!.own, true);
  assert.deepEqual(nextStep(b), { kind: "coverArt" });
  assert.match(b.coverArt!.prompt!, /^A brass compass/);
  const c = make({ title: "Storm" });
  requestCoverArt(c, { style: "photo", count: 1 });
  await runStep(c, { kind: "coverBrief" }, model({ json: async () => { throw new Error("Ollama isn't running"); } }), signal());
  assert.match(c.coverArt!.prompt!, /lighthouse keeper/);
  assert.match(c.coverArt!.concept!, /Quick brief.*Ollama isn't running/);
});

test("Cover art: a failed picture is reported on the cover, never pausing the book", async () => {
  const b = make();
  requestCoverArt(b, { prompt: "A brass compass on a weathered sea chart, warm candlelight", count: 3 });
  await runStep(b, { kind: "coverArt" }, model({ coverPicture: async () => { throw new Error("ComfyUI isn't running"); } }), signal());
  assert.equal(b.coverArt!.error, "ComfyUI isn't running");
  assert.equal(b.coverArt!.pending, 0);
  assert.equal(b.paused, undefined);
  assert.equal(b.error, undefined);
  assert.notDeepEqual(nextStep(b), { kind: "coverArt" });
  // No picture tool at all
  const c = make();
  requestCoverArt(c, { prompt: "A brass compass on a weathered sea chart, warm candlelight", count: 1 });
  await runStep(c, { kind: "coverArt" }, model({ coverPicture: undefined }), signal());
  assert.match(c.coverArt!.error!, /tools service with ComfyUI/);
  // Stopping keeps the options; forgetting drops them
  const d = make();
  requestCoverArt(d, { prompt: "A brass compass on a weathered sea chart, warm candlelight", count: 3 });
  await runStep(d, { kind: "coverArt" }, model(), signal());
  stopCoverArt(d);
  assert.equal(d.coverArt!.pending, 0);
  assert.equal(d.coverArt!.options.length, 1);
  stopCoverArt(d, true);
  assert.equal(d.coverArt, undefined);
});

// --- Typography ------------------------------------------------------------------------------------

test("Type: font pairs and layouts follow the genre until you choose", () => {
  assert.equal(coverDesignFor(make({ genre: "Romance", brief: "Two rivals fall in love at a wedding." })).pair.id, "romance");
  assert.equal(coverDesignFor(make({ genre: "Thriller", brief: "A spy in Berlin." })).pair.id, "thriller");
  assert.equal(coverDesignFor(make({ genre: "Epic fantasy", brief: "A dragon and a young mage." })).pair.id, "epic");
  const pic = make({ kind: "picture", brief: "A bunny who can't sleep." });
  assert.deepEqual([coverDesignFor(pic).pair.id, coverDesignFor(pic).layout], ["playful", "bottom"]);
  // A chosen palette steers the fonts too
  const b = make({ genre: "Thriller", brief: "A spy in Berlin.", coverColors: "fantasy-dragon" });
  assert.equal(coverDesignFor(b).pair.id, "epic");
  assert.equal(setCoverDesign(b, { fonts: "modern", layout: "frame" }), null);
  assert.deepEqual([coverDesignFor(b).pair.id, coverDesignFor(b).layout, coverDesignFor(b).auto], ["modern", "frame", false]);
  assert.equal(setCoverDesign(b, { fonts: "comic-sans" }), "Unknown fonts “comic-sans”");
  assert.match(setCoverDesign(b, { layout: "diagonal" })!, /The layout is one of/);
  assert.equal(setCoverDesign(b, { fonts: "auto" }), null);
  assert.equal(coverDesignFor(b).pair.id, "epic");
  assert.equal(setCoverDesign(b, null), null);
  assert.equal(b.coverDesign, undefined);
});

test("Type: fonts are embedded in the cover (the sidecar has no network)", () => {
  for (const pair of FONT_PAIRS) {
    const css = fontCss(pair);
    assert.match(css.faces, /@font-face \{ font-family: "[^"]+"; font-style: (normal|italic); font-weight: \d+; src: url\(data:font\/woff2;base64,[A-Za-z0-9+/]{1000,}/, pair.id);
    assert.match(css.title, /, Georgia, "Times New Roman", serif$/);
  }
  const spec = coverSpec("6x9", 200, "white");
  const html = coverHtml(spec, { title: "Dead Drop", author: "A. Writer", blurb: "B", fonts: fontPairById("thriller"), palette: { bg: "#101820", fg: "#ffffff", accent: "#f2aa4c" } });
  assert.match(html, /font-family: "Oswald"/);
  assert.match(html, /text-transform: uppercase;/);
  assert.match(html, /\.spine-text \{[^}]*font-family: "Oswald"/);
});

test("Type: each layout places the title differently, on the paperback and the ebook cover", () => {
  const spec = coverSpec("6x9", 200, "white");
  const base = { title: "The Keeper", subtitle: "A novel", author: "A. Writer", blurb: "B", image: "data:image/png;base64,AAAA", palette: { bg: "#123c4a", fg: "#ffffff", accent: "#e8a33d" }, fonts: fontPairById("classic") };
  const marks: Record<string, RegExp> = { bands: /class="zone band top"/, bottom: /class="zone foot"><h1>/, top: /class="zone head"><h1>/, frame: /class="zone card"/, split: /class="front split"/ };
  const seen = new Set<string>();
  for (const layout of LAYOUTS) {
    for (const html of [coverHtml(spec, { ...base, layout }), ebookCoverHtml({ ...base, layout })]) {
      assert.match(html, marks[layout], layout);
      assert.match(html, /The Keeper/);
      assert.match(html, /A\. Writer/);
    }
    seen.add(coverHtml(spec, { ...base, layout }));
  }
  assert.equal(seen.size, LAYOUTS.length);
  // Without a picture, the plain typographic front
  assert.match(coverHtml(spec, { ...base, image: undefined, layout: "split" }), /class="front plain"/);
});
