// Tests for reading attached PDFs.   npm test
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DocCache, cleanName, extractPdf, partsOf, withPageMarks } from "../src/hq/docs";
import { Uploads } from "../src/hq/uploads";

/** A real (tiny) PDF with one text line per entry, one page per array. */
export function makePdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const content = lines.map((l, k) => `BT /F1 12 Tf 72 ${720 - k * 18} Td (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out +=
    `xref\n0 ${objs.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("text comes out page by page", async () => {
  const doc = await extractPdf(makePdf([["Quarterly report", "Revenue rose 12% to $4.1M (Q3)"], ["Page two: costs fell 3%"]]), "q3.pdf");
  assert.equal(doc.name, "q3.pdf");
  assert.equal(doc.totalPages, 2);
  assert.match(doc.pages[0], /Quarterly report/);
  assert.match(doc.pages[0], /Revenue rose 12% to \$4\.1M \(Q3\)/);
  assert.match(doc.pages[1], /costs fell 3%/);
  assert.equal(doc.scanned, false);
  assert.match(withPageMarks(doc), /^\[Page 1\]\nQuarterly report[\s\S]*\[Page 2\]\nPage two/);
});

test("pages without text are flagged as probably scanned", async () => {
  const doc = await extractPdf(makePdf([[], []]));
  assert.equal(doc.scanned, true);
  assert.match(withPageMarks(doc), /\(no text on this page\)/);
});

test("a broken file gives a readable error", async () => {
  await assert.rejects(extractPdf(Buffer.from("%PDF-1.4\nthis is not really a pdf")), /This PDF can't be read/);
});

test("long documents split into parts of whole pages", async () => {
  const pages = Array.from({ length: 9 }, (_, i) => [`Section ${i + 1}`, "x".repeat(80)]);
  const doc = await extractPdf(makePdf(pages));
  const parts = partsOf(doc, 300);
  assert.ok(parts.length > 1);
  assert.equal(parts[0].from, 0);
  for (let k = 1; k < parts.length; k++) assert.equal(parts[k].from, parts[k - 1].to, "no page skipped or repeated");
  assert.equal(parts[parts.length - 1].to, 9);
  assert.ok(parts.every((p) => p.text.length <= 300));
  assert.match(parts[1].text, new RegExp(`^\\[Page ${parts[1].from + 1}\\]`));
});

test("PDF uploads: only real PDFs, cached text, safe names", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "docs-"));
  const up = new Uploads(dir);
  const pdf = makePdf([["hello"]]);
  const saved = up.save(`data:application/pdf;base64,${pdf.toString("base64")}`, "pdf");
  assert.ok(!("error" in saved));
  if ("error" in saved) return;
  assert.match(saved.id, /^[a-f0-9]{64}\.pdf$/);
  assert.equal(up.read(saved.id)?.type, "application/pdf");
  assert.match((up.save(Buffer.from("not a pdf").toString("base64"), "pdf") as { error: string }).error, /isn't a PDF/);
  assert.match((up.save(pdf.toString("base64"), "image") as { error: string }).error, /Only PNG/);
  const cache = new DocCache(path.join(dir, "uploads"));
  cache.set(saved.id, await extractPdf(pdf, "a.pdf"));
  assert.equal(cache.get(saved.id)?.pages[0], "hello");
  assert.equal(cache.get("../../etc/passwd"), null);
  assert.equal(cleanName("C:\\Users\\me\\Report ⟦P⟧<b>.pdf"), "Report Pb.pdf");
  assert.equal(cleanName(undefined), "document.pdf");
});
