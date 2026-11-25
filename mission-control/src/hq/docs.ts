// PDFs attached to cards. Text is pulled out with pdf.js (pure JavaScript; nothing in
// the file runs, fonts aren't loaded and nothing is fetched), cached next to the upload,
// and given to the agent. Long documents are read in parts by Jarvis File, which keeps
// what matters for the request, so they fit a local model's context.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;
export const DOC_ID = /^[a-f0-9]{64}\.pdf$/;

export interface PdfText {
  name: string;
  pages: string[];
  totalPages: number; // pages in the file; only the first MAX_PDF_PAGES are read
  title?: string;
  // Little or no text layer: probably scanned or photographed pages
  scanned: boolean;
}

export const isPdf = (buf: Buffer) => buf.length > 8 && buf.subarray(0, 1024).toString("latin1").includes("%PDF-");

/** Pulls the text out of a PDF, page by page. Throws a readable error for broken or locked files. */
export async function extractPdf(buf: Buffer, name = "document.pdf"): Promise<PdfText> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    // No fonts loaded, no network, no XFA forms: only the text is wanted
    disableFontFace: true,
    useWorkerFetch: false,
    enableXfa: false,
    useSystemFonts: false,
    verbosity: 0,
    stopAtErrors: false,
  });
  try {
    const doc = await task.promise;
    const count = Math.min(doc.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      pages.push(text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim());
      page.cleanup();
    }
    let title: string | undefined;
    try {
      const info = (await doc.getMetadata()).info as { Title?: unknown };
      if (typeof info?.Title === "string" && info.Title.trim()) title = info.Title.trim().slice(0, 200);
    } catch {
      // no metadata
    }
    const chars = pages.reduce((a, p) => a + p.length, 0);
    return { name, pages, totalPages: doc.numPages, title, scanned: chars < 15 * Math.max(1, count) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg) || (e as { name?: string })?.name === "PasswordException") throw new Error("This PDF is password-protected; remove the password and attach it again");
    throw new Error(`This PDF can't be read (${msg.slice(0, 120)})`);
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** The text cache that sits next to an uploaded PDF. */
export class DocCache {
  constructor(private dir: string) {}

  private file(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  get(id: string): PdfText | null {
    if (!DOC_ID.test(id) || !existsSync(this.file(id))) return null;
    try {
      return JSON.parse(readFileSync(this.file(id), "utf8")) as PdfText;
    } catch {
      return null;
    }
  }

  set(id: string, text: PdfText) {
    if (DOC_ID.test(id)) writeFileSync(this.file(id), JSON.stringify(text));
  }
}

/** A file name safe to show and store. */
export function cleanName(name: unknown): string {
  const base = typeof name === "string" ? name.split(/[\\/]/).pop() ?? "" : "";
  const clean = base.replace(/[\u0000-\u001f\u007f⟦⟧<>"]/g, "").trim().slice(0, 120);
  return clean || "document.pdf";
}

/** The whole text with page markers. */
export function withPageMarks(doc: PdfText, from = 0, to = doc.pages.length): string {
  return doc.pages
    .slice(from, to)
    .map((t, i) => `[Page ${from + i + 1}]\n${t || "(no text on this page)"}`)
    .join("\n\n");
}

/** Splits a document into parts of whole pages, each under `maxChars` (a long page is cut). */
export function partsOf(doc: PdfText, maxChars: number): { from: number; to: number; text: string }[] {
  const parts: { from: number; to: number; text: string }[] = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < doc.pages.length; i++) {
    const len = doc.pages[i].length + 12;
    if (size && size + len > maxChars) {
      parts.push({ from: start, to: i, text: withPageMarks(doc, start, i).slice(0, maxChars) });
      start = i;
      size = 0;
    }
    size += len;
  }
  if (start < doc.pages.length) parts.push({ from: start, to: doc.pages.length, text: withPageMarks(doc, start).slice(0, maxChars) });
  return parts;
}

/** How many pages a PDF has (for KDP: margins and the spine depend on it). */
export async function pdfPageCount(buf: Buffer): Promise<number> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useWorkerFetch: false, enableXfa: false, useSystemFonts: false, verbosity: 0 });
  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy();
  }
}
