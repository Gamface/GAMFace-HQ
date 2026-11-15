// Tests for PDF reports.   npm test
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderMarkdown } from "../src/hq/markdown";
import { FILE_ID, Files, buildReport, fetchPicture, pdfInstructions, wantsPdf } from "../src/hq/pdf";
import { Uploads } from "../src/hq/uploads";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("Markdown: headings, emphasis, lists, tables, quotes and code", () => {
  const html = renderMarkdown(
    "## Beans\nSome **bold**, *italic*, ~~old~~ and `code`.\n\n- one\n  - nested\n- two\n\n1. first\n2. second\n\n| A | B |\n| :-- | --: |\n| x | y |\n\n> quoted\n\n```\nlet a = 1;\n```\n\n---",
  );
  assert.match(html, /<h2>Beans<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>.*<em>italic<\/em>.*<del>old<\/del>.*<code>code<\/code>/);
  assert.match(html, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/, "a numbered list after bullets is its own list");
  assert.match(html, /<th style="text-align:left">A<\/th><th style="text-align:right">B<\/th>/);
  assert.match(html, /<td style="text-align:left">x<\/td>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>let a = 1;<\/code><\/pre>/);
  assert.match(html, /<hr>/);
});

test("Markdown: the agent's HTML and scripts are shown as text, never run", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))\n\n```\n<b>hi</b>\n```');
  assert.ok(!/<script|<img|javascript:/i.test(html.replace(/&lt;script|&lt;img/g, "")), html);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<p>click<\/p>/, "unsafe links lose their target");
  assert.match(html, /&lt;b&gt;hi&lt;\/b&gt;/);
});

test("Markdown: pictures become figures; unavailable ones are left out", () => {
  const html = renderMarkdown("![Beans](https://a.example/b.png)\n\n![Fake](https://x.invalid/f.jpg)\n\nText with ![icon](https://a.example/b.png) inline.", (src) =>
    src.includes("a.example") ? "data:image/png;base64,AAAA" : null,
  );
  assert.match(html, /<figure><img src="data:image\/png;base64,AAAA" alt="Beans"><figcaption>Beans<\/figcaption><\/figure>/);
  assert.ok(!html.includes("Fake"), "a missing figure disappears");
  assert.match(html, /Text with <img src="data:image\/png;base64,AAAA" alt="icon"> inline\./);
});

test("PDF requests are recognised; reading a PDF is not making one", () => {
  for (const t of ["Give me 5 types of coffee report in pdf and a picture of each", "Export this as a PDF", "make a pdf of the plan", "can I get that as PDF?"])
    assert.equal(wantsPdf(t), true, t);
  for (const t of ["Summarize the attached pdf", "read this PDF and tell me the total", "What is a database?", "pdfplumber vs pypdf"])
    assert.equal(wantsPdf(t), false, t);
  assert.match(pdfInstructions(["a".repeat(64) + ".png"]), /upload:a{64}\.png/);
  assert.match(pdfInstructions(), /Never invent image URLs/);
});

test("pictures: uploads embed, private addresses and non-pictures are refused, redirects are checked", async () => {
  const up = new Uploads(mkdtempSync(path.join(tmpdir(), "pdfu-")));
  const saved = up.save(PNG.toString("base64"));
  assert.ok(!("error" in saved));
  if ("error" in saved) return;
  for (const src of [`upload:${saved.id}`, `/api/uploads/${saved.id}`, `http://127.0.0.1:3000/api/uploads/${saved.id}`]) {
    const r = await fetchPicture(src, { uploads: up });
    assert.ok("data" in r && r.data.startsWith("data:image/png;base64,"), src);
  }
  assert.deepEqual(await fetchPicture("http://192.168.1.1/admin.png", {}), { error: "private network addresses are blocked" });
  assert.deepEqual(await fetchPicture("file:///etc/passwd", {}), { error: "not a web address" });
  const html = (async () => new Response("<html>not a picture</html>", { headers: { "content-type": "image/png" } })) as typeof fetch;
  assert.deepEqual(await fetchPicture("https://93.184.216.34/p.png", { fetchImpl: html }), { error: "not a picture" });
  const redirect = (async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/secret.png" } })) as typeof fetch;
  assert.deepEqual(await fetchPicture("https://93.184.216.34/p.png", { fetchImpl: redirect }), { error: "private network addresses are blocked" });
  const ok = (async () => new Response(PNG)) as typeof fetch;
  const r = await fetchPicture("https://93.184.216.34/p.png", { fetchImpl: ok });
  assert.ok("data" in r && r.data.startsWith("data:image/png"));
});

test("report HTML: the answer's # heading becomes the title; missing pictures are listed", async () => {
  const fetchImpl = (async (u: string | URL | Request) => (String(u).includes("good") ? new Response(PNG) : new Response("nope", { status: 404 }))) as typeof fetch;
  const r = await buildReport("# Coffee Guide\n\nIntro.\n\n![Espresso](https://93.184.216.34/good.png)\n\n![Latte](https://93.184.216.34/bad.png)", { title: "card title" }, { fetchImpl });
  assert.equal(r.title, "Coffee Guide");
  assert.equal(r.pictures, 1);
  assert.deepEqual(r.missing, [{ src: "https://93.184.216.34/bad.png", error: "HTTP 404" }]);
  assert.equal((r.html.match(/<h1>/g) ?? []).length, 1, "title shown once");
  assert.ok(!/<script/i.test(r.html));
});

test("saved files get safe names", () => {
  const files = new Files(mkdtempSync(path.join(tmpdir(), "pdff-")));
  const a = files.save("Five Types of Coffee: a Guide!", Buffer.from("%PDF-1.4 test"));
  assert.match(a.name, /^five-types-of-coffee-a-guide-[a-f0-9]{8}\.pdf$/);
  assert.ok(files.read(a.name)?.toString().startsWith("%PDF"));
  assert.equal(files.save("***", Buffer.from("%PDF x")).name.startsWith("report-"), true);
  for (const bad of ["../secret.pdf", "a.pdf", "x/../../y-12345678.pdf", "Upper-12345678.pdf"]) assert.equal(FILE_ID.test(bad) && files.path(bad) !== null, false, bad);
});
