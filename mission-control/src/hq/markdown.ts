// A small Markdown renderer for PDF reports. Everything the agent wrote is escaped
// first, so no HTML or script from an answer ever reaches the page. Supports
// headings, paragraphs, bold/italic/strikethrough, inline code, fenced code,
// links, pictures, bullet and numbered lists (nested), tables, quotes and rules.

export type ImageResolver = (src: string) => string | null; // data URI, or null when unavailable

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

export const IMAGE_PATTERN = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Picture sources in the order they appear. */
export function imageSources(md: string): string[] {
  return [...md.matchAll(IMAGE_PATTERN)].map((m) => m[2]);
}

function inline(text: string, img: ImageResolver): string {
  // Code spans are kept verbatim; everything else is formatted
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
      let s = esc(part);
      s = s.replace(/!\[([^\]]*)\]\(\s*(?:&lt;)?([^)\s]+?)(?:&gt;)?(?:\s+&quot;[^&]*&quot;)?\s*\)/g, (_m, alt: string, src: string) => {
        const data = img(unesc(src));
        return data
          ? `<img src="${esc(data)}" alt="${alt}">`
          : `<span class="missing">[picture unavailable${alt ? `: ${alt}` : ""}]</span>`;
      });
      // URLs may hold one level of parentheses, like Wikipedia links
      s = s.replace(/\[([^\]]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)\s*\)/g, (m, label: string, href: string) => {
        const url = unesc(href);
        return /^(https?:|mailto:)/i.test(url) ? `<a href="${esc(url)}">${label}</a>` : label;
      });
      s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_m, pre: string, url: string) => `${pre}<a href="${url}">${url}</a>`);
      s = s.replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>").replace(/__(?=\S)(.+?)__/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\*)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_(?=\S)([^_]+?)_(?![_\w])/g, "$1<em>$2</em>");
      s = s.replace(/~~(?=\S)(.+?)~~/g, "<del>$1</del>");
      return s;
    })
    .join("");
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableRule = (l: string | undefined) => l !== undefined && l.includes("|") && TABLE_RULE.test(l);
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const isBlockStart = (l: string, next?: string) =>
  /^\s*(#{1,6})\s/.test(l) || /^\s*```/.test(l) || /^\s*>/.test(l) || HR.test(l) || LIST_ITEM.test(l) || (l.includes("|") && isTableRule(next));

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function renderList(lines: string[], img: ImageResolver): string {
  // lines are list items (with indentation) and their continuation lines
  const items: { indent: number; ordered: boolean; text: string; children: string[] }[] = [];
  const base = (LIST_ITEM.exec(lines[0])?.[1] ?? "").length;
  for (const l of lines) {
    const m = LIST_ITEM.exec(l);
    if (m && m[1].length <= base + 1) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3], children: [] });
    else if (items.length) {
      if (m) items[items.length - 1].children.push(l);
      else if (items[items.length - 1].children.length) items[items.length - 1].children.push(l);
      else items[items.length - 1].text += ` ${l.trim()}`;
    }
  }
  const tag = items[0]?.ordered ? "ol" : "ul";
  return `<${tag}>${items
    .map((it) => `<li>${inline(it.text, img)}${it.children.length ? renderList(it.children.filter((c) => c.trim()), img) : ""}</li>`)
    .join("")}</${tag}>`;
}

export function renderMarkdown(md: string, img: ImageResolver = () => null): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*```\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2], img)}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(body.join("\n"), img)}</blockquote>`);
      continue;
    }
    if (line.includes("|") && isTableRule(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "left"));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (c: string, k: number, t: string) => `<${t} style="text-align:${align[k] ?? "left"}">${inline(c, img)}</${t}>`;
      out.push(
        `<table><thead><tr>${head.map((c, k) => td(c, k, "th")).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => td(r[k] ?? "", k, "td")).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const body: string[] = [];
      const first = LIST_ITEM.exec(line)!;
      const ordered = /\d/.test(first[2]);
      // A top-level item of the other kind (bullets vs numbers) starts a new list
      const sameKind = (l: string) => {
        const m = LIST_ITEM.exec(l);
        return !m || m[1].length > first[1].length + 1 || /\d/.test(m[2]) === ordered;
      };
      while (i < lines.length) {
        const l = lines[i];
        if ((LIST_ITEM.test(l) && sameKind(l)) || (/^\s+\S/.test(l) && !LIST_ITEM.test(l) && body.length) || (/^\s+/.test(l) && LIST_ITEM.test(l) && body.length && sameKind(l)))
          body.push(lines[i++]);
        else if (!l.trim() && LIST_ITEM.test(lines[i + 1] ?? "") && sameKind(lines[i + 1])) i++;
        else break;
      }
      out.push(renderList(body, img));
      continue;
    }
    // Paragraph; a picture alone on its line becomes a figure with its caption
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && (!para.length || !isBlockStart(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
    const only = para.length === 1 ? new RegExp(`^${IMAGE_PATTERN.source}$`).exec(para[0]) : null;
    // A picture that couldn't be fetched is left out of the document
    if (only && !img(only[2])) continue;
    if (only) out.push(`<figure>${inline(para[0], img)}${only[1] ? `<figcaption>${esc(only[1])}</figcaption>` : ""}</figure>`);
    else out.push(`<p>${inline(para.join(" "), img)}</p>`);
  }
  return out.join("\n");
}
