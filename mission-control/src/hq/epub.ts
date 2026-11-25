// EPUB 3 ebooks, built here with no packages: a small ZIP writer (Node's zlib does the
// compression and the CRC) and the handful of XML files an EPUB needs. The result opens
// in Apple Books, Kobo, Google Play Books, Calibre and Thorium, and Amazon KDP accepts
// it as an upload. A toc.ncx is included too, for older readers.

import { randomUUID } from "node:crypto";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface EpubChapter {
  title: string;
  /** XHTML body content (no <html> or <body>) */
  xhtml: string;
}

export interface EpubInput {
  title: string;
  author: string;
  language?: string;
  /** A stable id for the book (a UUID); a new one each time when left out */
  id?: string;
  description?: string;
  subtitle?: string;
  chapters: EpubChapter[];
  cover?: { data: Buffer; mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };
  modified?: Date;
}

// --- ZIP -------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
  /** false stores the file as it is (the EPUB's mimetype must be stored) */
  compress?: boolean;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A ZIP archive. Entries are written in the order given. */
export function zip(entries: ZipEntry[], when = new Date()): Buffer {
  const { time, date } = dosTime(when);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const compress = e.compress !== false;
    const body = compress ? deflateRawSync(e.data, { level: 9 }) : e.data;
    const crc = crc32(e.data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(compress ? 8 : 0, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(compress ? 8 : 0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Reads the entries back out of a ZIP made by zip() (for tests and checks). */
export function unzip(buf: Buffer): { name: string; data: Buffer; stored: boolean }[] {
  const out: { name: string; data: Buffer; stored: boolean }[] = [];
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const body = buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
    out.push({ name, data: method === 8 ? inflateRawSync(body) : Buffer.from(body), stored: method === 0 });
    p += 30 + nameLen + extra + size;
  }
  return out;
}

// --- EPUB ------------------------------------------------------------------------

export const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Makes renderMarkdown's HTML valid XHTML: void elements are closed, and named
 * entities XML doesn't know become characters.
 */
export function toXhtml(html: string): string {
  return html
    .replace(/<(hr|br|img|col|wbr)(\s[^<>]*?)?\s*\/?>/gi, (_m, tag: string, attrs = "") => `<${tag.toLowerCase()}${attrs}/>`)
    .replace(/&nbsp;/g, "&#160;")
    .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, "&amp;");
}

export const BOOK_CSS = `
body { font-family: Georgia, "Times New Roman", serif; line-height: 1.5; margin: 0 4%; }
h1 { font-size: 1.6em; text-align: center; margin: 2.5em 0 1.5em; font-weight: normal; page-break-before: always; break-before: page; }
h1 .num { display: block; font-size: 0.6em; letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 0.6em; }
h2 { font-size: 1.25em; margin: 1.6em 0 0.6em; }
h3 { font-size: 1.1em; margin: 1.3em 0 0.5em; }
p { margin: 0; text-indent: 1.4em; text-align: justify; }
h1 + p, h2 + p, h3 + p, hr + p, blockquote + p, ul + p, ol + p, table + p, .first { text-indent: 0; }
hr { border: none; text-align: center; margin: 1.2em 0; }
hr::after { content: "* * *"; letter-spacing: 0.5em; }
blockquote { margin: 1em 1.5em; font-style: italic; }
ul, ol { margin: 0.6em 0 0.8em 1.4em; padding: 0; }
li { margin: 0.2em 0; }
table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
th, td { border: 1px solid #999; padding: 0.3em 0.5em; text-align: left; vertical-align: top; }
code { font-family: monospace; font-size: 0.9em; }
pre { white-space: pre-wrap; font-size: 0.85em; }
.title-page { text-align: center; margin-top: 30%; }
.title-page h1 { page-break-before: auto; break-before: auto; font-size: 2em; margin: 0 0 0.4em; }
.title-page .subtitle { font-style: italic; margin-bottom: 2em; }
.title-page .author { font-size: 1.2em; }
.cover { text-align: center; margin: 0; padding: 0; }
.cover img { max-width: 100%; max-height: 100%; }
`;

const page = (title: string, lang: string, body: string, extraHead = "") =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n` +
  `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">\n` +
  `<head><meta charset="utf-8"/><title>${xmlEsc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/>${extraHead}</head>\n` +
  `<body>${body}</body>\n</html>\n`;

/** Builds an EPUB 3 file. */
export function buildEpub(input: EpubInput): Buffer {
  const lang = (input.language || "en").replace(/[^A-Za-z-]/g, "") || "en";
  const id = input.id || randomUUID();
  const modified = (input.modified ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const coverExt = input.cover ? { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[input.cover.mime] : "";
  const chapters = input.chapters.map((c, i) => ({ ...c, file: `chapter-${String(i + 1).padStart(3, "0")}.xhtml`, idref: `ch${i + 1}` }));

  const files: ZipEntry[] = [
    { name: "mimetype", data: Buffer.from("application/epub+zip"), compress: false },
    {
      name: "META-INF/container.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
          `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>\n`,
      ),
    },
    { name: "OEBPS/style.css", data: Buffer.from(BOOK_CSS) },
  ];

  const manifest: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    `<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`,
  ];
  const spine: string[] = [];

  if (input.cover && coverExt) {
    files.push({ name: `OEBPS/cover.${coverExt}`, data: input.cover.data, compress: false });
    files.push({
      name: "OEBPS/cover.xhtml",
      data: Buffer.from(page("Cover", lang, `<section class="cover" epub:type="cover"><img src="cover.${coverExt}" alt="${xmlEsc(input.title)}"/></section>`)),
    });
    manifest.push(`<item id="cover-image" href="cover.${coverExt}" media-type="${input.cover.mime}" properties="cover-image"/>`);
    manifest.push(`<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="cover" linear="no"/>`);
  }

  files.push({
    name: "OEBPS/title.xhtml",
    data: Buffer.from(
      page(
        input.title,
        lang,
        `<section class="title-page" epub:type="titlepage"><h1>${xmlEsc(input.title)}</h1>` +
          (input.subtitle ? `<p class="subtitle">${xmlEsc(input.subtitle)}</p>` : "") +
          `<p class="author">${xmlEsc(input.author)}</p></section>`,
      ),
    ),
  });
  spine.push(`<itemref idref="title"/>`);

  for (const c of chapters) {
    files.push({ name: `OEBPS/${c.file}`, data: Buffer.from(page(c.title, lang, `<section epub:type="chapter">${c.xhtml}</section>`)) });
    manifest.push(`<item id="${c.idref}" href="${c.file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${c.idref}"/>`);
  }

  files.push({
    name: "OEBPS/nav.xhtml",
    data: Buffer.from(
      page(
        "Contents",
        lang,
        `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>` + chapters.map((c) => `<li><a href="${c.file}">${xmlEsc(c.title)}</a></li>`).join("") + `</ol></nav>` +
          `<nav epub:type="landmarks" hidden=""><ol><li><a epub:type="titlepage" href="title.xhtml">Title page</a></li>` +
          (chapters.length ? `<li><a epub:type="bodymatter" href="${chapters[0].file}">Start</a></li>` : "") +
          `</ol></nav>`,
      ),
    ),
  });
  files.push({
    name: "OEBPS/toc.ncx",
    data: Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n` +
        `<head><meta name="dtb:uid" content="urn:uuid:${id}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n` +
        `<docTitle><text>${xmlEsc(input.title)}</text></docTitle>\n<navMap>` +
        chapters.map((c, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${xmlEsc(c.title)}</text></navLabel><content src="${c.file}"/></navPoint>`).join("") +
        `</navMap>\n</ncx>\n`,
    ),
  });

  files.push({
    name: "OEBPS/content.opf",
    data: Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">\n` +
        `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
        `<dc:identifier id="bookid">urn:uuid:${id}</dc:identifier>\n` +
        `<dc:title>${xmlEsc(input.title)}</dc:title>\n` +
        `<dc:creator>${xmlEsc(input.author)}</dc:creator>\n` +
        `<dc:language>${lang}</dc:language>\n` +
        (input.description ? `<dc:description>${xmlEsc(input.description)}</dc:description>\n` : "") +
        `<meta property="dcterms:modified">${modified}</meta>\n` +
        (input.cover && coverExt ? `<meta name="cover" content="cover-image"/>\n` : "") +
        `</metadata>\n<manifest>\n${manifest.join("\n")}\n</manifest>\n` +
        `<spine toc="ncx">\n${spine.join("\n")}\n</spine>\n</package>\n`,
    ),
  });

  return zip(files, input.modified);
}
