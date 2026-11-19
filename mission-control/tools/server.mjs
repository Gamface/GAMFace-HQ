// Mission Control tools service. Starts the MCP servers listed in tools.json (each a
// program speaking MCP over stdio) and lets the harness use them over HTTP:
//
//   GET  /health                         -> { ok, servers: [{ name, ok, error? }] }
//   GET  /tools                          -> { servers: [{ name, description, ok, error?, tools: [...] }] }
//   POST /call { server, tool, args, timeoutMs?, allowChange? }
//                                        -> { text, isError, ms, media? } | { error }
//
// It runs in its own container: internet for the tools, but none of your files and
// none of Mission Control's keys. Only the harness can reach it. A tool that isn't
// read-only runs only when the harness says the change was approved (allowChange).

import { readFileSync } from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = Number(process.env.PORT || 3040);
const CONFIG = process.env.TOOLS_CONFIG || new URL("./tools.json", import.meta.url).pathname;
const MAX_TEXT = 20000;
const MAX_CALL_MS = 600000;
// Pictures (MCP image parts) and video clips (embedded MP4 resources) a tool returns are passed
// on to the harness as `media`, which saves them on the card
const MAX_MEDIA = 4;
const MAX_MEDIA_BASE64 = 16 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4"]);
const CONNECT_MS = 30000;
const RETRY_MS = 30000;
const LIST_CACHE_MS = 60000;
const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// --- Config -------------------------------------------------------------------------

/** Reads and checks tools.json. Returns the servers by name. Exported for tests. */
export function parseConfig(text) {
  const raw = JSON.parse(text);
  const out = {};
  for (const [name, s] of Object.entries(raw.servers ?? {})) {
    if (!NAME.test(name)) throw new Error(`Server name "${name}" must be lowercase letters, digits, - or _`);
    if (!s || typeof s.command !== "string" || !s.command) throw new Error(`Server "${name}" needs a command`);
    if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string"))) throw new Error(`Server "${name}": args must be a list of strings`);
    if (s.only !== undefined && (!Array.isArray(s.only) || s.only.some((a) => typeof a !== "string"))) throw new Error(`Server "${name}": only must be a list of tool names`);
    if (s.hideParams !== undefined && (!Array.isArray(s.hideParams) || s.hideParams.some((a) => typeof a !== "string"))) throw new Error(`Server "${name}": hideParams must be a list of names`);
    if (s.defaults !== undefined && (typeof s.defaults !== "object" || Array.isArray(s.defaults) || s.defaults === null)) throw new Error(`Server "${name}": defaults must be an object`);
    out[name] = {
      name,
      description: typeof s.description === "string" ? s.description : "",
      command: s.command,
      args: s.args ?? [],
      env: s.env && typeof s.env === "object" ? s.env : {},
      enabled: s.enabled !== false,
      readOnly: s.readOnly === true,
      tools: s.tools && typeof s.tools === "object" ? s.tools : {},
      // When set, only these of the server's tools are offered (an allowlist)
      only: s.only ? new Set(s.only) : null,
      // Tips the agents see with this server's tools (valid values, how the tools fit together)
      notes: typeof s.notes === "string" ? s.notes.slice(0, 800) : "",
      // Parameters the agents never see or set (plumbing flags), and values sent on every call
      hideParams: new Set(s.hideParams ?? []),
      defaults: s.defaults ?? {},
      // How long one call may take (slow tools like picture making); the harness waits this long
      timeoutMs: Number.isFinite(s.timeoutMs) ? Math.min(MAX_CALL_MS, Math.max(1000, s.timeoutMs)) : undefined,
    };
  }
  return out;
}

/** The server's environment: the safe defaults plus only the variables it names ("$NAME" reads ours). */
export function serverEnv(env, source = process.env) {
  const out = { ...getDefaultEnvironment() };
  for (const [k, v] of Object.entries(env)) {
    const val = typeof v === "string" && v.startsWith("$") ? source[v.slice(1)] : v;
    if (typeof val === "string" && val) out[k] = val;
  }
  return out;
}

/** Whether a tool only reads: a per-tool setting, else the server's readOnly, else the tool's own readOnlyHint. */
export function isReadOnly(server, tool) {
  const own = server.tools[tool.name];
  if (own && typeof own.readOnly === "boolean") return own.readOnly;
  if (server.readOnly) return true;
  return tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
}

/** A tool's parameters as the agents see them: hidden ones left out. Exported for tests. */
export function visibleSchema(server, schema) {
  if (!schema || !server.hideParams.size) return schema;
  const props = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => !server.hideParams.has(k)));
  const required = (schema.required ?? []).filter((k) => !server.hideParams.has(k));
  return { ...schema, properties: props, ...(schema.required ? { required } : {}) };
}

/** The arguments actually sent: hidden ones dropped, then the server's defaults for parameters this tool has. Exported for tests. */
export function callArgs(server, schema, args) {
  const has = new Set(Object.keys(schema?.properties ?? {}));
  const out = Object.fromEntries(Object.entries(args).filter(([k]) => !server.hideParams.has(k)));
  for (const [k, v] of Object.entries(server.defaults)) if (has.has(k)) out[k] = v;
  return out;
}

/** A tool result as text: text parts joined, other parts named, capped. */
export function resultText(res) {
  const parts = [];
  for (const c of res?.content ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "resource" && typeof c.resource?.text === "string") parts.push(c.resource.text);
    else if (c.type === "resource_link") parts.push(`[link: ${c.name ?? ""} ${c.uri}]`);
    else if (c.type === "image" && IMAGE_TYPES.has(c.mimeType)) continue; // passed on by resultMedia
    else if (c.type === "resource" && VIDEO_TYPES.has(c.resource?.mimeType) && typeof c.resource?.blob === "string") continue; // likewise
    else parts.push(`[${c.type} omitted]`);
  }
  if (!parts.length && res?.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent));
  const text = parts.join("\n").trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut: ${text.length - MAX_TEXT} more characters]` : text;
}

/**
 * The pictures (PNG, JPEG or WebP image parts) and video clips (MP4 resources with a blob) in a
 * tool result, at most four, each capped. Exported for tests.
 */
export function resultMedia(res) {
  const ok = (data) => typeof data === "string" && data.length > 0 && data.length <= MAX_MEDIA_BASE64;
  return (res?.content ?? [])
    .flatMap((c) => {
      if (c.type === "image" && IMAGE_TYPES.has(c.mimeType) && ok(c.data)) return [{ mimeType: c.mimeType, data: c.data }];
      if (c.type === "resource" && VIDEO_TYPES.has(c.resource?.mimeType) && ok(c.resource?.blob)) return [{ mimeType: c.resource.mimeType, data: c.resource.blob }];
      return [];
    })
    .slice(0, MAX_MEDIA);
}

// --- Connections ----------------------------------------------------------------------

const conns = new Map(); // name -> { client, connecting, error, failedAt, listedAt, tools }

async function connect(server) {
  let c = conns.get(server.name);
  if (c?.client) return c;
  if (c?.connecting) return c.connecting;
  if (c?.error && Date.now() - c.failedAt < RETRY_MS) throw new Error(c.error);
  c = { client: null, connecting: null, error: null, failedAt: 0, listedAt: 0, tools: [] };
  conns.set(server.name, c);
  c.connecting = (async () => {
    const transport = new StdioClientTransport({ command: server.command, args: server.args, env: serverEnv(server.env), stderr: "pipe" });
    transport.stderr?.on("data", (d) => process.stderr.write(`[${server.name}] ${d}`));
    const client = new Client({ name: "mission-control-tools", version: "1.0.0" });
    client.onclose = () => {
      // The server exited: start it again on the next use
      if (conns.get(server.name)?.client === client) conns.delete(server.name);
    };
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(`didn't start within ${CONNECT_MS / 1000}s`)), CONNECT_MS));
    try {
      await Promise.race([client.connect(transport), timer]);
    } catch (e) {
      await transport.close().catch(() => {});
      throw e;
    }
    c.client = client;
    c.connecting = null;
    console.log(`${server.name}: connected`);
    return c;
  })().catch((e) => {
    c.connecting = null;
    c.error = e instanceof Error ? e.message : String(e);
    c.failedAt = Date.now();
    console.log(`${server.name}: ${c.error}`);
    throw new Error(c.error);
  });
  return c.connecting;
}

async function listTools(server) {
  const c = await connect(server);
  if (Date.now() - c.listedAt >= LIST_CACHE_MS) {
    const all = [];
    let cursor;
    do {
      const page = await c.client.listTools(cursor ? { cursor } : undefined);
      all.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && all.length < 500);
    // The server's own list is cached; the settings are applied on every read
    c.tools = all;
    c.listedAt = Date.now();
  }
  return c.tools
    .filter((t) => server.tools[t.name]?.enabled !== false && (!server.only || server.only.has(t.name)))
    .map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: visibleSchema(server, t.inputSchema), readOnly: isReadOnly(server, t), annotations: t.annotations ?? {} }));
}

// --- HTTP -------------------------------------------------------------------------------

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > 1_000_000) throw new Error("Request too large");
    chunks.push(ch);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export function createServer(servers) {
  const enabled = () => Object.values(servers).filter((s) => s.enabled);
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, { ok: true, servers: enabled().map((s) => ({ name: s.name, ok: Boolean(conns.get(s.name)?.client), error: conns.get(s.name)?.error ?? undefined })) });
      }
      if (req.method === "GET" && req.url === "/tools") {
        const out = await Promise.all(
          enabled().map(async (s) => {
            try {
              return { name: s.name, description: s.description, notes: s.notes || undefined, timeoutMs: s.timeoutMs, ok: true, tools: await listTools(s) };
            } catch (e) {
              return { name: s.name, description: s.description, ok: false, error: e instanceof Error ? e.message : String(e), tools: [] };
            }
          }),
        );
        return send(res, 200, { servers: out });
      }
      if (req.method === "POST" && req.url === "/call") {
        const body = await readBody(req);
        const server = servers[String(body.server ?? "")];
        if (!server || !server.enabled) return send(res, 404, { error: `No tool server "${body.server}"` });
        const tools = await listTools(server);
        const tool = tools.find((t) => t.name === body.tool);
        if (!tool) return send(res, 404, { error: `${server.name} has no tool "${body.tool}"` });
        if (!tool.readOnly && body.allowChange !== true) return send(res, 403, { error: `${server.name}.${tool.name} changes things, so it needs approval` });
        const given = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
        const timeout = Math.min(server.timeoutMs ?? 300000, Math.max(1000, Number(body.timeoutMs) || 60000));
        const c = await connect(server);
        // The full schema (with hidden parameters) decides which defaults apply
        const raw = c.tools.find((t) => t.name === tool.name);
        const args = callArgs(server, raw?.inputSchema, given);
        const started = Date.now();
        try {
          const out = await c.client.callTool({ name: tool.name, arguments: args }, undefined, { timeout });
          const media = resultMedia(out);
          return send(res, 200, { text: resultText(out), isError: Boolean(out.isError), ms: Date.now() - started, ...(media.length ? { media } : {}) });
        } catch (e) {
          return send(res, 200, { text: `The tool failed: ${e instanceof Error ? e.message : String(e)}`, isError: true, ms: Date.now() - started });
        }
      }
      send(res, 404, { error: "Not found" });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let servers = {};
  try {
    servers = parseConfig(readFileSync(CONFIG, "utf8"));
  } catch (e) {
    console.error(`tools.json: ${e instanceof Error ? e.message : e}`);
  }
  createServer(servers).listen(PORT, "0.0.0.0", () => {
    const names = Object.values(servers).filter((s) => s.enabled).map((s) => s.name);
    console.log(`Tools service on port ${PORT}: ${names.length ? names.join(", ") : "no servers"}`);
  });
  const stop = async () => {
    for (const c of conns.values()) await c.client?.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
