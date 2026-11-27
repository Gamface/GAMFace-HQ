import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPalette, coverHtml, coverSpec, frontDpi, imageSize } from "../src/hq/kdp";
import { newBook, editBook } from "../src/hq/books";

const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

test("picture sizes are read from PNG and JPEG headers", () => {
  assert.deepEqual(imageSize(png(1216, 832)), [1216, 832]);
  assert.deepEqual(imageSize(jpeg(1600, 2560)), [1600, 2560]);
  assert.equal(imageSize(Buffer.from("not a picture at all, nope")), null);
});

test("the front panel's dpi and what 300 dpi needs", () => {
  const spec = coverSpec("6x9", 200, "white");
  const low = frontDpi(spec, [896, 1200]);
  assert.deepEqual(low.need, [1838, 2775]);
  assert.ok(low.dpi < 300 && low.dpi > 100, String(low.dpi));
  assert.ok(frontDpi(spec, [1900, 2800]).dpi >= 300);
});

test("cover colours: hex only, #rgb widened, [] back to the title's colours", () => {
  assert.deepEqual(cleanPalette(["#101820", "#f2a", "#FFFFFF"]), { bg: "#101820", accent: "#ff22aa", fg: "#ffffff" });
  assert.equal(cleanPalette(["navy", "#fff", "#000"]), "invalid");
  assert.equal(cleanPalette([]), null);
  const made = newBook({ title: "Night Shift", kind: "novel", brief: "A detective story in the rain-soaked city." });
  assert.ok(!("error" in made));
  const book = made;
  assert.equal(editBook(book as never, { coverColors: ["red", "#fff", "#000"] }), "Cover colours are three #rrggbb colours: background, accent, text");
  assert.equal(editBook(book as never, { coverColors: ["#101820", "#f2aa4c", "#ffffff"], coverHasText: true }), null);
  assert.deepEqual((book as { coverColors: unknown }).coverColors, { bg: "#101820", accent: "#f2aa4c", fg: "#ffffff" });
  assert.equal((book as { coverHasText: boolean }).coverHasText, true);
});

test("a finished cover is printed as it is; colours reach the back and spine", () => {
  const spec = coverSpec("6x9", 200, "white");
  const base = { title: "Night Shift", author: "A. Writer", blurb: "Rain.", image: "data:image/png;base64,AAAA", palette: { bg: "#101820", fg: "#ffffff", accent: "#f2aa4c" } };
  const plain = coverHtml(spec, base);
  assert.match(plain, /<h1[^>]*>Night Shift<\/h1>/);
  const done = coverHtml(spec, { ...base, finished: true });
  assert.doesNotMatch(done.split('class="front"')[1].split("</div>")[0], /Night Shift|A\. Writer/, "no title over a finished cover");
  assert.match(done, /#101820/);
});
