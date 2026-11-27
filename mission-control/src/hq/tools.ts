import { lookup } from "node:dns/promises";
import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from "express";
import { redact } from "./guard";
import { sanitize } from "./privacy";

// Tools for the agents: MCP servers run by the tools service (tools/, its own container).
// The harness lists their tools and calls them over HTTP. Read-only tools just run.
// A tool that changes things runs only after the user approves that exact call, and
// never in routines or read-only runs. Tool output comes from outside services, so it's
// treated like a web page: untrusted, cleaned of private-context markers and secrets
// before any model or log sees it.

export interface ToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  readOnly: boolean;
  /** The tool's own MCP hints (readOnlyHint, destructiveHint, …) */
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean; [k: string]: unknown };
  /** Its server's tips from tools.json (valid values, how the tools fit together) */
  notes?: string;
  /** How long one call may take (its server's timeoutMs in tools.json) */
  timeoutMs?: number;
}

/**
 * Whether a tool that changes things may also destroy or overwrite something. MCP says
 * a tool is destructive unless it says otherwise, so only destructiveHint: false is not.
 */
export function isDestructive(t: ToolInfo): boolean {
  return !t.readOnly && t.annotations?.destructiveHint !== false;
}

/**
 * The tools a card may use: read-only tools always; tools that change things only on
 * cards you started that aren't read-only (never routines: nobody is there to approve).
 */
export function toolsFor(task: { readOnly?: boolean; routine: boolean }, servers: ToolServer[]): ToolInfo[] {
  const mayChange = !task.readOnly && !task.routine;
  return servers.flatMap((s) => (s.ok ? s.tools.filter((t) => t.readOnly || mayChange) : []));
}

export interface ToolServer {
  name: string;
  description: string;
  ok: boolean;
  error?: string;
  notes?: string;
  timeoutMs?: number;
  tools: ToolInfo[];
}

/** A picture or video clip a tool made */
export interface ToolMedia {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4";
  /** base64 */
  data: string;
}

export interface ToolResult {
  text: string;
  isError: boolean;
  ms: number;
  /** Pictures and clips the tool made (saved on the card by the caller; never shown to a model) */
  media?: ToolMedia[];
}

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "video/mp4"]);

/** The pictures and clips in a tools-service reply that are well formed. Exported for tests. */
export function toolMedia(raw: unknown): ToolMedia[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i): i is ToolMedia => Boolean(i) && MEDIA_TYPES.has((i as ToolMedia).mimeType) && typeof (i as ToolMedia).data === "string" && /^[A-Za-z0-9+/]+=*$/.test((i as ToolMedia).data))
    .slice(0, 4);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`It took longer than ${Math.round(ms / 1000)} s`)), ms)))]).finally(() => clearTimeout(timer));
}

/** "demo.echo" → { server: "demo", tool: "echo" } */
export function splitToolName(full: string): { server: string; tool: string } | null {
  const m = /^([a-z0-9][a-z0-9_-]{0,40})\.(.+)$/.exec(full.trim());
  return m ? { server: m[1], tool: m[2] } : null;
}

/** Tool output made safe to show a model or a log. Exported for tests. */
export function cleanToolText(text: string): string {
  return redact(sanitize(text)).text;
}

/** "::ffff:172.20.0.3" → "172.20.0.3" */
const plainIp = (ip: string | undefined) => (ip ?? "").replace(/^::ffff:/, "");

/**
 * Refuses every request that comes from the tools container. The harness and the tools
 * service share a network so the harness can call tools; this keeps a tool from calling
 * back into Mission Control's own API. The address is looked up again every 30 seconds
 * (it changes when the container is recreated).
 */
export function refuseFromHost(host: string, resolve: (h: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)) {
  let ips = new Set<string>();
  let at = 0;
  const refresh = async () => {
    at = Date.now();
    try {
      ips = new Set((await resolve(host)).map(plainIp));
    } catch {
      ips = new Set(); // not running: nothing can come from it
    }
  };
  const ready = refresh();
  const middleware = async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    if (Date.now() - at > 30_000) await refresh();
    if (ips.has(plainIp(req.socket.remoteAddress))) return res.status(403).json({ error: "Tools can't call Mission Control" });
    next();
  };
  return Object.assign(middleware, { ready });
}

/**
 * Tools that run inside the harness itself instead of the tools service (the music studio's,
 * which only the harness can reach). Same rules: read-only ones just run, the others only after
 * the user approves the call.
 */
export interface LocalTool extends Omit<ToolInfo, "server" | "notes" | "timeoutMs"> {
  run: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean; media?: ToolMedia[] }>;
}
export interface LocalToolServer {
  name: string;
  description: string;
  notes?: string;
  timeoutMs?: number;
  tools: LocalTool[];
}

export class ToolsClient {
  private cache: { at: number; servers: ToolServer[] } | null = null;

  /** `base` is the tools service ("" for none); `local` are the harness's own tool servers */
  constructor(
    private base: string,
    private local: LocalToolServer[] = [],
  ) {}

  private localServers(): ToolServer[] {
    return this.local.map((s) => ({
      name: s.name,
      description: s.description,
      ok: true,
      ...(s.notes ? { notes: s.notes } : {}),
      ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}),
      tools: s.tools.map(({ run: _run, ...t }) => ({ ...t, server: s.name, ...(s.notes ? { notes: s.notes } : {}), ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}) })),
    }));
  }

  private async request<T>(route: string, init: RequestInit, timeoutMs: number): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${this.base}${route}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new Error(`The tools service isn't reachable (${e instanceof Error ? e.message : String(e)}). Is the tools container running?`);
    }
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `The tools service said ${r.status}`);
    return body;
  }

  async health(): Promise<{ ok: boolean; servers: { name: string; ok: boolean; error?: string }[] } | null> {
    if (!this.base) return this.local.length ? { ok: true, servers: this.local.map((s) => ({ name: s.name, ok: true })) } : null;
    try {
      return await this.request("/health", {}, 4000);
    } catch {
      return null;
    }
  }

  /** Every enabled server and its tools (kept for a minute). The harness's own come first. */
  async list(fresh = false): Promise<ToolServer[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < 60_000) return this.cache.servers;
    let remote: ToolServer[] = [];
    if (this.base) {
      try {
        const out = await this.request<{ servers: (Omit<ToolServer, "tools"> & { tools: Omit<ToolInfo, "server">[] })[] }>("/tools", {}, 45_000);
        remote = out.servers
          .filter((s) => !this.local.some((l) => l.name === s.name))
          .map((s) => ({
            ...s,
            tools: s.tools.map((t) => ({ ...t, server: s.name, ...(s.notes ? { notes: s.notes } : {}), ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}) })),
          }));
      } catch (e) {
        // The harness's own tools still work while the tools service is down
        if (!this.local.length) throw e;
        return this.localServers();
      }
    }
    const servers = [...this.localServers(), ...remote];
    this.cache = { at: Date.now(), servers };
    return servers;
  }

  async find(server: string, tool: string): Promise<ToolInfo | null> {
    const servers = await this.list();
    return servers.find((s) => s.name === server)?.tools.find((t) => t.name === tool) ?? null;
  }

  /**
   * Calls a tool. A tool that changes things runs only with `approved: true`, which the
   * caller passes after the user approved this exact call; the tools service checks too.
   */
  async call(server: string, tool: string, args: Record<string, unknown>, opts: { approved?: boolean; timeoutMs?: number } = {}): Promise<ToolResult> {
    const info = await this.find(server, tool);
    if (!info) throw new Error(`No tool ${server}.${tool}`);
    const timeoutMs = opts.timeoutMs ?? info.timeoutMs ?? 60_000;
    const allowChange = !info.readOnly && opts.approved === true;
    if (!info.readOnly && !allowChange) throw new Error(`${server}.${tool} changes things, so it needs your approval first`);
    const own = this.local.find((s) => s.name === server)?.tools.find((t) => t.name === tool);
    if (own) {
      const started = Date.now();
      try {
        const out = await withTimeout(own.run(args), timeoutMs);
        const media = toolMedia(out.media);
        return { text: cleanToolText(out.text), isError: Boolean(out.isError), ms: Date.now() - started, ...(media.length ? { media } : {}) };
      } catch (e) {
        return { text: cleanToolText(e instanceof Error ? e.message : String(e)), isError: true, ms: Date.now() - started };
      }
    }
    const out = await this.request<Omit<ToolResult, "media"> & { media?: unknown }>(
      "/call",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server, tool, args, timeoutMs, ...(allowChange ? { allowChange } : {}) }) },
      timeoutMs + 10_000,
    );
    const media = toolMedia(out.media);
    return { text: cleanToolText(out.text ?? ""), isError: Boolean(out.isError), ms: out.ms, ...(media.length ? { media } : {}) };
  }
}
