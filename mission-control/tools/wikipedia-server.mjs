// Wikipedia tools (read-only): search articles and read one, through Wikipedia's public
// API. No key needed. Only en.wikipedia.org (or another language's wikipedia.org) is called.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Wikimedia asks API clients to send a descriptive User-Agent
const UA = "MissionControlTools/1.0 (self-hosted AI assistant; read-only Wikipedia lookups)";
const LANG = /^[a-z]{2,3}(-[a-z]+)?$/;

/** Exported for tests: the API address for a language. */
export function apiUrl(lang, params) {
  if (!LANG.test(lang)) throw new Error(`"${lang}" isn't a Wikipedia language code (like en, de, fr)`);
  const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  for (const [k, v] of Object.entries({ format: "json", formatversion: "2", utf8: "1", ...params })) u.searchParams.set(k, String(v));
  return u.toString();
}

/** Search snippets come with HTML highlights; this leaves plain text. Exported for tests. */
export function plain(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Wikipedia answered ${r.status}`);
  return r.json();
}

const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });

const server = new McpServer({ name: "wikipedia", version: "1.0.0" });

server.registerTool(
  "search",
  {
    description: "Search Wikipedia articles. Returns titles, short snippets and links; read one with article.",
    inputSchema: {
      query: z.string().min(1).describe("What to search for"),
      limit: z.number().int().min(1).max(10).optional().describe("How many results (default 5)"),
      lang: z.string().optional().describe("Wikipedia language code (default en)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, limit = 5, lang = "en" }) => {
    try {
      const d = await getJson(apiUrl(lang, { action: "query", list: "search", srsearch: query, srlimit: limit }));
      const hits = d.query?.search ?? [];
      if (!hits.length) return text(`No Wikipedia articles found for "${query}".`);
      return text(
        hits
          .map((h, i) => `${i + 1}. ${h.title}\n   ${plain(h.snippet)}\n   https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`)
          .join("\n"),
      );
    } catch (e) {
      return fail(`Wikipedia search failed: ${e instanceof Error ? e.message : e}`);
    }
  },
);

server.registerTool(
  "article",
  {
    description: "Read a Wikipedia article as plain text (the lead section by default, or the whole article).",
    inputSchema: {
      title: z.string().min(1).describe("The article title, as search returned it"),
      full: z.boolean().optional().describe("The whole article instead of just the lead section"),
      chars: z.number().int().min(500).max(20000).optional().describe("At most this many characters (default 6000)"),
      lang: z.string().optional().describe("Wikipedia language code (default en)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ title, full = false, chars = 6000, lang = "en" }) => {
    try {
      const d = await getJson(apiUrl(lang, { action: "query", prop: "extracts|info", inprop: "url", explaintext: 1, redirects: 1, titles: title, ...(full ? {} : { exintro: 1 }) }));
      const page = d.query?.pages?.[0];
      if (!page || page.missing) return fail(`There's no Wikipedia article called "${title}". Use search to find the exact title.`);
      const body = String(page.extract ?? "").trim();
      const cut = body.length > chars ? `${body.slice(0, chars)}\n[cut: ${body.length - chars} more characters]` : body;
      return text(`${page.title}\n${page.fullurl ?? ""}\n\n${cut || "(no text)"}`);
    } catch (e) {
      return fail(`Reading the article failed: ${e instanceof Error ? e.message : e}`);
    }
  },
);

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  await server.connect(new StdioServerTransport());
}
