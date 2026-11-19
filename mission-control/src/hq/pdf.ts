// PDF reports. An agent's Markdown answer becomes a styled HTML document, which the
// browser sidecar prints to PDF (Page.printToPDF). Pictures are fetched here, with the
// same address checks as the browser, and embedded, so the print page itself makes no
// network requests at all: it runs in a throwaway profile with every request blocked.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Cdp, blockedReason, resolveCdpUrl } from "./browser";
import { IMAGE_PATTERN, imageSources, renderMarkdown } from "./markdown";
import type { Uploads } from "./uploads";

export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const MAX_PICTURES = 20;
const PICTURE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Whether a request asks for a PDF to be made (not read). */
export function wantsPdf(text: string): boolean {
  if (!/\bpdfs?\b/i.test(text)) return false;
  if (/\b(read|open|parse|extract|summari[sz]e|translate|review)\b[^.?!]{0,40}\b(this|the|my|attached|that)\b[^.?!]{0,20}\bpdf/i.test(text)) return false;
  return true;
}

/** What an agent is told when its answer will become a PDF. */
export function pdfInstructions(uploadIds: string[] = []): string {
  return (
    "\n\nOUTPUT FORMAT: Mission Control turns your answer into a PDF document automatically. " +
    "Write the complete document itself in Markdown: a # title, ## sections, paragraphs, lists and tables. " +
    "Don't ask where to save it, don't describe the PDF and don't say you can't make files: just write the content. " +
    "For pictures write ![caption](URL) on its own line, using only image URLs you actually saw on a web page" +
    (uploadIds.length ? ` or the user's attached pictures: ${uploadIds.map((id) => `upload:${id}`).join(", ")}` : "") +
    ". Never invent image URLs; if you have no real picture, leave it out."
  );
}

function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export interface PictureOptions {
  uploads?: Uploads;
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Fetches one picture as a data URI, or explains why it can't be used. */
export async function fetchPicture(src: string, opts: PictureOptions): Promise<{ data: string } | { error: string }> {
  // The user's own uploads: upload:<id>, /api/uploads/<id> or a full harness URL
  const up = /^(?:upload:|.*\/api\/uploads\/)([a-f0-9]{64}\.(?:png|jpg|gif|webp))$/.exec(src);
  if (up) {
    const b64 = opts.uploads?.base64(up[1]);
    if (!b64) return { error: "unknown upload" };
    return { data: `data:${sniff(Buffer.from(b64.slice(0, 64), "base64")) ?? "image/png"};base64,${b64}` };
  }
  if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) return src.length < MAX_PICTURE_BYTES * 1.4 ? { data: src } : { error: "too large" };
  if (!/^https?:\/\//i.test(src)) return { error: "not a web address" };
  const doFetch = opts.fetchImpl ?? fetch;
  let url = src;
  // Follow redirects by hand so every hop gets the address check
  for (let hop = 0; hop < 4; hop++) {
    const blocked = await blockedReason(url, opts.allowPrivate);
    if (blocked) return { error: blocked };
    let res: Response;
    try {
      res = await doFetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
        headers: { Accept: "image/png,image/jpeg,image/gif,image/webp", "User-Agent": "Mozilla/5.0 (Mission Control report builder)" },
      });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url).toString();
      continue;
    }
    if (!res.ok) return { error: `HTTP ${res.status}` };
    if (Number(res.headers.get("content-length") ?? 0) > MAX_PICTURE_BYTES) return { error: "too large" };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PICTURE_BYTES) return { error: "too large" };
    // Trust the bytes, not the header: only real PNG/JPEG/GIF/WebP pictures go in
    const type = sniff(buf);
    if (!type) return { error: "not a picture" };
    return { data: `data:${type};base64,${buf.toString("base64")}` };
  }
  return { error: "too many redirects" };
}

const CSS = `
@page { size: A4; margin: 18mm 16mm 20mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; line-height: 1.55; color: #1f2933; margin: 0; }
header.doc { border-bottom: 3px solid #0e7490; padding-bottom: 10px; margin-bottom: 18px; }
header.doc h1 { margin: 0 0 4px; font-size: 22pt; color: #0b3b4a; line-height: 1.2; }
header.doc .meta { color: #6b7785; font-size: 9pt; }
h1 { font-size: 18pt; color: #0b3b4a; margin: 22px 0 8px; }
h2 { font-size: 14pt; color: #0e7490; margin: 20px 0 6px; border-bottom: 1px solid #d9e2ec; padding-bottom: 3px; break-after: avoid; }
h3 { font-size: 12pt; color: #134e5e; margin: 14px 0 4px; break-after: avoid; }
h4, h5, h6 { font-size: 10.5pt; margin: 12px 0 4px; break-after: avoid; }
p { margin: 0 0 8px; }
a { color: #0e7490; text-decoration: none; }
ul, ol { margin: 0 0 8px; padding-left: 22px; }
li { margin: 2px 0; }
code { font-family: Consolas, "Courier New", monospace; font-size: 9pt; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }
pre { background: #f1f5f9; border: 1px solid #d9e2ec; border-radius: 4px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid #0e7490; color: #3e4c59; background: #f5fafb; }
table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; font-size: 9.5pt; }
th { background: #0e7490; color: #fff; font-weight: 600; }
th, td { border: 1px solid #cbd5e1; padding: 5px 7px; vertical-align: top; }
tr { break-inside: avoid; }
tbody tr:nth-child(even) td { background: #f8fafc; }
img { max-width: 100%; max-height: 95mm; object-fit: contain; border-radius: 4px; }
figure { margin: 10px 0 14px; text-align: center; break-inside: avoid; }
figcaption { font-size: 9pt; color: #52606d; margin-top: 4px; font-style: italic; }
td img { max-height: 40mm; }
hr { border: none; border-top: 1px solid #d9e2ec; margin: 14px 0; }
.missing { color: #9aa5b1; font-style: italic; font-size: 9pt; }
`;

/** Builds the report HTML. Pictures are fetched (in parallel) and embedded. */
export async function buildReport(
  markdown: string,
  meta: { title: string; date?: Date; author?: string },
  opts: PictureOptions = {},
): Promise<{ html: string; title: string; pictures: number; missing: { src: string; error: string }[] }> {
  const srcs = [...new Set(imageSources(markdown))].slice(0, MAX_PICTURES);
  const results = await Promise.all(srcs.map(async (s) => [s, await fetchPicture(s, opts)] as const));
  const found = new Map<string, string>();
  const missing: { src: string; error: string }[] = [];
  for (const [s, r] of results) "data" in r ? found.set(s, r.data) : missing.push({ src: s, error: r.error });
  // A leading "# Title" becomes the document title instead of being shown twice
  let body = markdown.trim();
  let title = meta.title;
  const h1 = /^#\s+(.+)\n?/.exec(body);
  if (h1) {
    title = h1[1].trim();
    body = body.slice(h1[0].length);
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const date = (meta.date ?? new Date()).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>` +
    `<header class="doc"><h1>${esc(title)}</h1><div class="meta">${esc(date)}${meta.author ? ` · ${esc(meta.author)}` : ""}</div></header>` +
    renderMarkdown(body, (s) => found.get(s) ?? null) +
    `</body></html>`;
  return { html, title, pictures: [...markdown.matchAll(IMAGE_PATTERN)].filter((m) => found.has(m[2])).length, missing };
}

/** Prints HTML to PDF in a throwaway browser profile with no network access. */
export async function printPdf(html: string, cdpBase: string): Promise<Buffer> {
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
      // Everything is embedded; anything that still tries the network is refused
      if (method === "Fetch.requestPaused") void cdp.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, s).catch(() => {});
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s);
    await cdp.send("Emulation.setScriptExecutionDisabled", { value: true }, s);
    await cdp.send("Page.enable", {}, s);
    const { frameTree } = await cdp.send("Page.getFrameTree", {}, s);
    await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html }, s);
    await Promise.race([load, new Promise((r) => setTimeout(r, 5000))]);
    await new Promise((r) => setTimeout(r, 250));
    const { data } = await cdp.send(
      "Page.printToPDF",
      {
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate:
          '<div style="font-size:8px;width:100%;text-align:center;color:#8794a1;font-family:Arial">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      },
      s,
      90000,
    );
    return Buffer.from(data, "base64");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not implemented|PrintToPDF/i.test(msg)) throw new Error("This Chrome can't print PDFs (only headless Chrome can). Point BROWSER_CDP_URL at the browser sidecar.");
    throw e;
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    if (contextId) await cdp.send("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => {});
    cdp.close();
  }
}

export const FILE_ID = /^[a-z0-9][a-z0-9-]{0,70}-[a-f0-9]{8}\.(pdf|mp4|png|jpg|webp)$/;
export type FileExt = "pdf" | "mp4" | "png" | "jpg" | "webp";

/** The Content-Type a saved file is served with. */
export function fileType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  return { mp4: "video/mp4", png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[ext] ?? "application/pdf";
}

/** Saved PDF reports, rendered videos and pictures tools made, in data/files. */
export class Files {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  save(title: string, pdf: Buffer, ext: FileExt = "pdf"): { name: string; bytes: number } {
    const slug =
      title
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/, "") || "report";
    const name = `${slug}-${createHash("sha256").update(pdf).digest("hex").slice(0, 8)}.${ext}`;
    writeFileSync(path.join(this.dir, name), pdf);
    return { name, bytes: pdf.length };
  }

  path(name: string): string | null {
    if (!FILE_ID.test(name)) return null;
    const p = path.join(this.dir, name);
    return existsSync(p) && statSync(p).isFile() ? p : null;
  }

  read(name: string): Buffer | null {
    const p = this.path(name);
    return p ? readFileSync(p) : null;
  }
}
