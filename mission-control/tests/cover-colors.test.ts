// Tests for book cover colours: the palette library, automatic picks, your own choices,
// colours from a picture, readability fixes, and the covers they print on.   npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { editBook, newBook, refreshAutoColors, runStep, setCoverColors } from "../src/hq/books";
import type { Book, BookModel } from "../src/hq/books";
import { coverHtml, coverSpec, ebookCoverHtml, listingPrompt, paletteFor, parseListing } from "../src/hq/kdp";
import {
  ACCENT_CONTRAST,
  PALETTES,
  PALETTE_GROUPS,
  TEXT_CONTRAST,
  autoPalette,
  automatic,
  colorsFor,
  contrast,
  decodePng,
  ensureReadable,
  normalizeHex,
  paletteById,
  paletteFromPixels,
  paletteLibrary,
  parseCoverColors,
  suggestPalettes,
  titlePalette,
} from "../src/hq/palettes";

function make(over: Record<string, unknown>): Book {
  const b = newBook({ brief: "A book long enough to pass the check.", ...over });
  assert.ok(!("error" in b));
  return b;
}

// --- The library -----------------------------------------------------------------------------

test("Palettes: over a hundred, unique ids, every group filled, all readable", () => {
  assert.ok(PALETTES.length >= 100, `${PALETTES.length} palettes`);
  assert.equal(new Set(PALETTES.map((p) => p.id)).size, PALETTES.length);
  for (const g of PALETTE_GROUPS) assert.ok(PALETTES.some((p) => p.group === g), `group ${g} is empty`);
  for (const p of PALETTES) {
    for (const c of [p.bg, p.fg, p.accent]) assert.match(c, /^#[0-9a-f]{6}$/, `${p.id} ${c}`);
    assert.ok(contrast(p.fg, p.bg) >= TEXT_CONTRAST, `${p.id}: text ${contrast(p.fg, p.bg).toFixed(2)}`);
    assert.ok(contrast(p.accent, p.bg) >= ACCENT_CONTRAST, `${p.id}: accent ${contrast(p.accent, p.bg).toFixed(2)}`);
  }
  const lib = paletteLibrary();
  assert.equal(lib.reduce((n, g) => n + g.palettes.length, 0), PALETTES.length);
  assert.ok(!("tags" in lib[0].palettes[0]));
});

test("Palettes: books that never chose colours keep the original title palette", () => {
  // The original algorithm and its five palettes, as they shipped
  const ORIGINAL = [
    { bg: "#1f2a44", fg: "#f5efe0", accent: "#d9a441" },
    { bg: "#2d3a2e", fg: "#f2f0e6", accent: "#c9b26b" },
    { bg: "#5b1f2a", fg: "#fbf3ea", accent: "#e8b86d" },
    { bg: "#f3ead8", fg: "#2b2b2b", accent: "#a6452b" },
    { bg: "#123c4a", fg: "#eef6f5", accent: "#7fc8c2" },
  ];
  const original = (title: string) => {
    let h = 0;
    for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return ORIGINAL[h % ORIGINAL.length];
  };
  for (const title of ["Tide & Time", "Untitled", "The Last Lighthouse", "A", "Ünïcødé Book", ""]) {
    assert.deepEqual(paletteFor(title), original(title));
    const { bg, fg, accent } = titlePalette(title);
    assert.deepEqual({ bg, fg, accent }, original(title));
  }
  // A book with no colours of its own prints exactly as before (with the old dark band)
  const c = colorsFor({ title: "Tide & Time" });
  assert.deepEqual({ bg: c.bg, fg: c.fg, accent: c.accent }, original("Tide & Time"));
  assert.equal(c.band, "dark");
});

// --- Colour maths ------------------------------------------------------------------------------

test("Colours: hex is normalized and contrast follows WCAG", () => {
  assert.equal(normalizeHex("#ABC"), "#aabbcc");
  assert.equal(normalizeHex("1f2a44"), "#1f2a44");
  assert.equal(normalizeHex(" #1F2A44 "), "#1f2a44");
  for (const bad of ["orange", "#12345", "#ggg", 7, null, ""]) assert.equal(normalizeHex(bad), null);
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
  assert.equal(contrast("#777777", "#777777"), 1);
});

test("Colours: unreadable text and accents are fixed, with a note", () => {
  const { colors, notes } = ensureReadable({ bg: "#1f2a44", fg: "#2a3550", accent: "#25304a" });
  assert.ok(contrast(colors.fg, colors.bg) >= TEXT_CONTRAST);
  assert.ok(contrast(colors.accent, colors.bg) >= ACCENT_CONTRAST);
  assert.equal(notes.length, 2);
  const light = ensureReadable({ bg: "#fafafa", fg: "#eeeeee", accent: "#f0f0f0" });
  assert.ok(contrast(light.colors.fg, "#fafafa") >= TEXT_CONTRAST);
  // Good colours are left alone
  const ok = ensureReadable({ bg: "#1f2a44", fg: "#f5efe0", accent: "#d9a441" });
  assert.deepEqual(ok.notes, []);
  assert.equal(ok.colors.fg, "#f5efe0");
});

// --- Automatic picks ---------------------------------------------------------------------------

test("Auto: the genre, brief and kind pick a fitting palette", () => {
  const group = (b: Record<string, string>) => autoPalette({ title: "", kind: "novel", ...b }).group;
  assert.equal(group({ genre: "Romance", brief: "Two rivals fall in love at a wedding." }), "romance");
  assert.equal(group({ genre: "Cozy mystery", brief: "A baker solves a murder in her village." }), "mystery");
  assert.equal(group({ genre: "Epic fantasy", brief: "A young mage hunts a dragon." }), "fantasy");
  assert.equal(group({ genre: "Science fiction", brief: "A starship crew finds an alien signal." }), "scifi");
  assert.equal(group({ genre: "Horror", brief: "A haunted house." }), "horror");
  assert.equal(autoPalette({ title: "", kind: "picture", brief: "A bunny who can't sleep." }).group, "children");
  assert.equal(autoPalette({ title: "", kind: "ebook", genre: "Investing", brief: "Grow your money." }).group, "business");
  assert.equal(autoPalette({ title: "", kind: "ebook", genre: "Cookbook", brief: "Sourdough bread recipes." }).group, "cookbook");
  assert.equal(autoPalette({ title: "", kind: "puzzle", brief: "Logic puzzles for the holidays." }).group, "bold");
  // Nothing to go on: the title's palette, as before
  const plain = autoPalette({ title: "Zq", kind: "other" });
  assert.equal(plain.id, titlePalette("Zq").id);
});

test("Auto: picks are stable for a book but vary between books of a genre", () => {
  const a = autoPalette({ title: "Love in Lisbon", kind: "novel", genre: "Romance" });
  assert.equal(autoPalette({ title: "Love in Lisbon", kind: "novel", genre: "Romance" }).id, a.id);
  const ids = new Set(["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"].map((t) => autoPalette({ title: t, kind: "novel", genre: "Romance" }).id));
  assert.ok(ids.size > 1, "every romance got the same palette");
  const s = suggestPalettes({ title: "x", kind: "novel", genre: "Thriller" }, 6);
  assert.equal(s.length, 6);
  assert.equal(s[0].group, "thriller");
  assert.equal(new Set(s.map((p) => p.id)).size, 6);
});

// --- Choosing ----------------------------------------------------------------------------------

test("Choosing: presets, auto, brand, objects and Jarvis-style lists", () => {
  const book = { title: "T", kind: "novel", genre: "Horror" };
  const pre = parseCoverColors("mystery-noir", book);
  assert.ok(pre && !("error" in pre));
  assert.equal(pre.source, "preset");
  assert.equal(pre.palette, "mystery-noir");
  assert.equal(pre.bg, paletteById("mystery-noir")!.bg);
  const auto = parseCoverColors("auto", book);
  assert.ok(auto && !("error" in auto) && auto.source === "auto");
  assert.equal(paletteById("horror-blood")?.group, "horror");
  const brand = parseCoverColors("brand", book, { background: "#0b1020", text: "#ffffff", accent: "#facc15" });
  assert.ok(brand && !("error" in brand));
  assert.deepEqual([brand.bg, brand.fg, brand.accent, brand.source], ["#0b1020", "#ffffff", "#facc15", "brand"]);
  assert.deepEqual(parseCoverColors("brand", book), { error: "There's no brand kit to take colours from" });
  const obj = parseCoverColors({ background: "#FFF", text: "#111", accent: "c00", band: "none", locked: true }, book);
  assert.ok(obj && !("error" in obj));
  assert.deepEqual([obj.bg, obj.fg, obj.accent, obj.source, obj.band, obj.locked], ["#ffffff", "#111111", "#cc0000", "custom", "none", true]);
  // [background, accent, text], the order Jarvis's book studio uses
  const list = parseCoverColors(["#101820", "#f2aa4c", "#ffffff"], book);
  assert.ok(list && !("error" in list));
  assert.deepEqual([list.bg, list.accent, list.fg], ["#101820", "#f2aa4c", "#ffffff"]);
  const str = parseCoverColors("#101820, #f2aa4c #fff", book);
  assert.ok(str && !("error" in str) && str.fg === "#ffffff");
  assert.equal(parseCoverColors(null, book), null);
  assert.equal(parseCoverColors([], book), null);
  // Mistakes are reported, never silently dropped
  assert.match((parseCoverColors(["#101820", "orange", "#fff"], book) as { error: string }).error, /“orange” isn't a hex colour/);
  assert.match((parseCoverColors(["#101820", "#fff"], book) as { error: string }).error, /need 3 colours/);
  assert.match((parseCoverColors({ bg: "#000", fg: "#fff" }, book) as { error: string }).error, /accent/);
  assert.match((parseCoverColors("no-such-palette", book) as { error: string }).error, /Unknown palette/);
});

test("Books: new books get colours for their genre; you can set, restyle, lock and clear them", () => {
  const b = make({ title: "Blood Moon Rising", genre: "Horror" });
  assert.equal(b.coverColors?.source, "auto");
  assert.equal(paletteById(autoPalette(b).id)?.group, "horror");
  // Chosen up front, or none at all
  const chosen = make({ coverColors: "scifi-neon" });
  assert.equal(chosen.coverColors?.palette, "scifi-neon");
  assert.equal(make({ coverColors: null }).coverColors, undefined);
  assert.deepEqual(newBook({ brief: "A book long enough to pass the check.", coverColors: "nope" }), { error: "Unknown palette “nope”" });

  // Auto colours follow the genre...
  assert.equal(editBook(b, { genre: "Romance", brief: "Two rivals fall in love at a wedding in Paris." }), null);
  assert.equal(paletteById(autoPalette(b).id)?.group, "romance");
  assert.equal(b.coverColors?.bg, autoPalette(b).bg);
  // ...until you choose
  assert.equal(editBook(b, { coverColors: "classic-navy" }), null);
  assert.equal(b.coverColors?.source, "preset");
  editBook(b, { genre: "Horror" });
  assert.equal(b.coverColors?.palette, "classic-navy");
  assert.equal(refreshAutoColors(b), false);
  // Band and lock change on their own, keeping the colours
  assert.equal(setCoverColors(b, { band: "none", locked: true }), null);
  assert.deepEqual([b.coverColors?.palette, b.coverColors?.band, b.coverColors?.locked], ["classic-navy", "none", true]);
  assert.equal(editBook(b, { coverColors: ["#101820", "orange", "#fff"] }), "“orange” isn't a hex colour like #1f2a44");
  assert.equal(b.coverColors?.palette, "classic-navy");
  // Brand colours come from the project's brand kit
  assert.equal(editBook(b, { coverColors: "brand" }, { background: "#0b1020", text: "#ffffff", accent: "#facc15" }), null);
  assert.equal(b.coverColors?.source, "brand");
  assert.equal(editBook(b, { coverColors: null }), null);
  assert.equal(b.coverColors, undefined);
});

test("Automation: what it may change and what it leaves alone", () => {
  assert.equal(automatic(undefined), true);
  for (const source of ["auto", "writer", "picture"] as const) {
    assert.equal(automatic({ bg: "#000000", fg: "#ffffff", accent: "#ff0000", source }), true);
    assert.equal(automatic({ bg: "#000000", fg: "#ffffff", accent: "#ff0000", source, locked: true }), false);
  }
  for (const source of ["preset", "custom", "brand"] as const) assert.equal(automatic({ bg: "#000000", fg: "#ffffff", accent: "#ff0000", source }), false);
});

test("Writer: the listing step picks a palette from a menu, but never over your choice", async () => {
  const listingJson = (palette: string) => ({
    json: { description: `<p>${"A clear, honest description. ".repeat(6)}</p>`, backCover: "Back", keywords: ["a b"], categories: [], palette },
    ref: "f",
  });
  let seen = "";
  const model = (palette: string): BookModel => ({
    write: async () => ({ text: "", ref: "f" }),
    json: async (m) => {
      seen = m.map((x) => x.content).join("\n");
      return listingJson(palette);
    },
    contextChars: () => 16000,
  });
  const b = make({ kind: "novel", genre: "Thriller", title: "Dead Drop" });
  b.bible = "## Plan";
  b.wantListing = true;
  await runStep(b, { kind: "listing" }, model("thriller-ice (Ice cold: …)"), new AbortController().signal);
  assert.match(seen, /"palette": "the cover colours/);
  assert.match(seen, /thriller-/);
  assert.equal(b.listing?.palette, "thriller-ice");
  assert.deepEqual([b.coverColors?.source, b.coverColors?.palette, b.coverColors?.bg], ["writer", "thriller-ice", paletteById("thriller-ice")!.bg]);

  // A made-up id is ignored
  const c = make({ kind: "novel", genre: "Thriller" });
  c.bible = "## Plan";
  const before = c.coverColors;
  await runStep(c, { kind: "listing" }, model("purple-rain"), new AbortController().signal);
  assert.equal(c.listing?.palette, undefined);
  assert.deepEqual(c.coverColors, before);

  // Your own colours: the Writer isn't even asked
  const d = make({ kind: "novel", genre: "Thriller", coverColors: "mono-white" });
  d.bible = "## Plan";
  await runStep(d, { kind: "listing" }, model("thriller-ice"), new AbortController().signal);
  assert.doesNotMatch(seen, /"palette"/);
  assert.equal(d.coverColors?.palette, "mono-white");
  assert.equal(listingPrompt({ ...d, chapters: [] }).map((m) => m.content).join("").includes('"palette"'), false);
  assert.equal(parseListing({ description: `<p>${"x ".repeat(60)}</p>`, palette: "fantasy-dragon" }).hasOwnProperty("palette"), true);
});

// --- From a picture ----------------------------------------------------------------------------

/** A PNG of the given pixels, rows filtered with each filter type in turn (as encoders do). */
function png(width: number, height: number, px: (x: number, y: number) => [number, number, number, number], rgba = true): Buffer {
  const bpp = rgba ? 4 : 3;
  const stride = width * bpp;
  const raw: number[] = [];
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push(...px(x, y).slice(0, bpp));
    rows.push(row);
    const f = y % 5;
    raw.push(f);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = y > 0 ? rows[y - 1][i] : 0;
      const c = i >= bpp && y > 0 ? rows[y - 1][i - bpp] : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw.push((row[i] - pred) & 0xff);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = rgba ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(raw))), chunk("IEND", Buffer.alloc(0))]);
}

test("Picture: PNGs decode exactly, through every row filter, RGB and RGBA", () => {
  const px = (x: number, y: number): [number, number, number, number] => [(x * 37 + y * 11) & 255, (x * 5 + y * 71) & 255, (x * y * 3) & 255, 255];
  for (const rgba of [true, false]) {
    const out = decodePng(png(13, 11, px, rgba));
    assert.equal(out.width, 13);
    assert.equal(out.height, 11);
    for (let y = 0; y < 11; y++) for (let x = 0; x < 13; x++) assert.deepEqual(out.pixels[y * 13 + x], px(x, y).slice(0, 3));
  }
  // Transparent pixels count as white paper
  const clear = decodePng(png(2, 1, () => [0, 0, 0, 0]));
  assert.deepEqual(clear.pixels[0], [255, 255, 255]);
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /Not a PNG/);
});

test("Picture: the main colour becomes the background, a vivid one the accent, all readable", () => {
  // A night-blue picture with a small orange moon
  const w = 32;
  const h = 48;
  const pixels: [number, number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push((x - 20) ** 2 + (y - 12) ** 2 < 30 ? [245, 140, 30] : [18, 28, 64]);
  const p = paletteFromPixels(pixels, w);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.bg.slice(i, i + 2), 16));
  assert.ok(b > r && b > g, `background ${p.bg} should be the blue`);
  const [ar, , ab] = [1, 3, 5].map((i) => parseInt(p.accent.slice(i, i + 2), 16));
  assert.ok(ar > ab, `accent ${p.accent} should be the orange`);
  assert.ok(contrast(p.fg, p.bg) >= TEXT_CONTRAST);
  assert.ok(contrast(p.accent, p.bg) >= ACCENT_CONTRAST);
  // A light, single-colour picture still gives readable colours
  const pale = paletteFromPixels(Array.from({ length: 64 }, () => [240, 236, 228] as [number, number, number]), 8);
  assert.ok(contrast(pale.fg, pale.bg) >= TEXT_CONTRAST);
  assert.ok(contrast(pale.accent, pale.bg) >= ACCENT_CONTRAST);
  assert.throws(() => paletteFromPixels([], 1), /no pixels/);
});

// --- On the cover --------------------------------------------------------------------------------

test("Covers: the book's colours print on the back, spine and front; the band follows the style", () => {
  const spec = coverSpec("6x9", 200, "white");
  const pal = { bg: "#101820", fg: "#ffffff", accent: "#f2aa4c" };
  const plain = coverHtml(spec, { title: "Dead Drop", author: "A", blurb: "Blurb.", palette: pal });
  assert.match(plain, /body \{ position: relative; background: #101820; color: #ffffff;/);
  assert.match(plain, /\.spine \{[^}]*background: #f2aa4c;/);
  assert.match(plain, /\.spine-text \{[^}]*color: #101820;/);
  const pic = (band?: "palette" | "dark" | "none") => coverHtml(spec, { title: "T", author: "A", blurb: "B", image: "data:image/png;base64,AAAA", palette: pal, band });
  assert.match(pic(), /\.band \{[^}]*background: rgba\(16,24,32,0\.82\); color: #ffffff;/);
  assert.match(pic("dark"), /\.band \{[^}]*background: rgba\(0,0,0,0\.38\); color: #fff;/);
  assert.match(pic("none"), /\.band \{[^}]*background: transparent;[^}]*text-shadow/);
  // No colours given: the title's palette and the old dark band, exactly as before
  const legacy = coverHtml(spec, { title: "Tide & Time", author: "A", blurb: "B", image: "data:image/png;base64,AAAA" });
  assert.match(legacy, new RegExp(`background: ${paletteFor("Tide & Time").bg};`));
  assert.match(legacy, /rgba\(0,0,0,0\.38\)/);
});

test("Covers: the ebook cover is the front alone, laid out at 6 × 9.6 in and zoomed to 1600 × 2560 px", () => {
  const html = ebookCoverHtml({ title: "Dead Drop", subtitle: "A <thriller>", author: "A", blurb: "", palette: { bg: "#101820", fg: "#ffffff", accent: "#f2aa4c" } });
  assert.match(html, /@page \{ size: 6in 9.6in;/);
  assert.match(html, /html \{ zoom: 2.778; \}/);
  assert.match(html, /background: #101820/);
  assert.match(html, /A &lt;thriller&gt;/);
  assert.doesNotMatch(html, /class="back"|class="spine"/);
});
