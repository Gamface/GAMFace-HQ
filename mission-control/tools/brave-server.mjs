// Brave Search tools (read-only): web and news search through Brave's Search API, so
// agents can search without loading search-engine pages (which now show bot checks).
// Needs BRAVE_API_KEY in tools/.env (free tier at https://api-dashboard.search.brave.com).
// Only api.search.brave.com is called; the key goes nowhere else.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const KEY = process.env.BRAVE_API_KEY ?? "";
const NO_KEY =
  "Brave Search isn't set up: add BRAVE_API_KEY=<your key> to tools/.env (free key at https://api-dashboard.search.brave.com), then run: docker compose up -d tools";

/** Exported for tests: the search address. */
export function searchUrl(kind, { query, count, freshness, country }) {
  const u = new URL(`https://api.search.brave.com/res/v1/${kind}/search`);
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(count));
  if (freshness) u.searchParams.set("freshness", freshness);
  if (country) u.searchParams.set("country", country);
  return u.toString();
}

/** Brave's results as numbered lines. Exported for tests. */
export function formatResults(items) {
  const strip = (s) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return items
    .map((r, i) => `${i + 1}. ${strip(r.title)}${r.age ? ` (${strip(r.age)})` : ""}\n   ${r.url}\n   ${strip(r.description)}`)
    .join("\n");
}

async function search(kind, args) {
  if (!KEY) return { content: [{ type: "text", text: NO_KEY }], isError: true };
  try {
    const r = await fetch(searchUrl(kind, args), {
      headers: { Accept: "application/json", "X-Subscription-Token": KEY },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 401 || r.status === 403) return { content: [{ type: "text", text: "Brave Search refused the key (check BRAVE_API_KEY in tools/.env)." }], isError: true };
    if (r.status === 429) return { content: [{ type: "text", text: "Brave Search's rate limit was reached; try again shortly." }], isError: true };
    if (!r.ok) return { content: [{ type: "text", text: `Brave Search answered ${r.status}.` }], isError: true };
    const d = await r.json();
    const items = kind === "news" ? (d.results ?? []) : (d.web?.results ?? []);
    if (!items.length) return { content: [{ type: "text", text: `No results for "${args.query}".` }] };
    return { content: [{ type: "text", text: formatResults(items.slice(0, args.count)) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Brave Search failed: ${e instanceof Error ? e.message : e}` }], isError: true };
  }
}

const params = {
  query: z.string().min(1).max(400).describe("What to search for"),
  count: z.number().int().min(1).max(20).optional().describe("How many results (default 8)"),
  freshness: z.enum(["pd", "pw", "pm", "py"]).optional().describe("Only results from the past day, week, month or year"),
  country: z.string().length(2).optional().describe("Two-letter country code to localise results, like us or gb"),
};

const server = new McpServer({ name: "brave", version: "1.0.0" });

server.registerTool(
  "web_search",
  {
    description: "Search the web with Brave Search. Returns titles, links, snippets and ages. Open a result with the browser if more is needed.",
    inputSchema: params,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, count = 8, freshness, country }) => search("web", { query, count, freshness, country }),
);

server.registerTool(
  "news_search",
  {
    description: "Search recent news with Brave Search. Returns headlines, links, snippets and how old each story is.",
    inputSchema: params,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, count = 8, freshness, country }) => search("news", { query, count, freshness, country }),
);

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  await server.connect(new StdioServerTransport());
}
