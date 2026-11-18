import { lookup } from "node:dns/promises";
import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from "express";
import { redact } from "./guard";
import { sanitize } from "./privacy";

// Tools for the agents: MCP servers run by the tools service (tools/, its own container).
// The harness lists their tools and calls them over HTTP. Step 1 of tool support:
// only read-only tools can be called; tools that change things wait for approvals.
// Tool output comes from outside services, so it's treated like a web page: untrusted,
// cleaned of private-context markers and secrets before any model or log sees it.

export interface ToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  readOnly: boolean;
}

export interface ToolServer {
  name: string;
  description: string;
  ok: boolean;
  error?: string;
  tools: ToolInfo[];
}

export interface ToolResult {
  text: string;
  isError: boolean;
  ms: number;
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

export class ToolsClient {
  private cache: { at: number; servers: ToolServer[] } | null = null;

  constructor(private base: string) {}

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
    try {
      return await this.request("/health", {}, 4000);
    } catch {
      return null;
    }
  }

  /** Every enabled server and its tools (kept for a minute). */
  async list(fresh = false): Promise<ToolServer[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < 60_000) return this.cache.servers;
    const out = await this.request<{ servers: (Omit<ToolServer, "tools"> & { tools: Omit<ToolInfo, "server">[] })[] }>("/tools", {}, 45_000);
    const servers = out.servers.map((s) => ({ ...s, tools: s.tools.map((t) => ({ ...t, server: s.name })) }));
    this.cache = { at: Date.now(), servers };
    return servers;
  }

  async find(server: string, tool: string): Promise<ToolInfo | null> {
    const servers = await this.list();
    return servers.find((s) => s.name === server)?.tools.find((t) => t.name === tool) ?? null;
  }

  /**
   * Calls a read-only tool. Tools that change things are refused here (and by the
   * tools service) until approvals for tools exist.
   */
  async call(server: string, tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolResult> {
    const info = await this.find(server, tool);
    if (!info) throw new Error(`No tool ${server}.${tool}`);
    if (!info.readOnly) throw new Error(`${server}.${tool} changes things, and tools that change things need approvals (not built yet)`);
    const out = await this.request<ToolResult>(
      "/call",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server, tool, args, timeoutMs }) },
      timeoutMs + 10_000,
    );
    return { ...out, text: cleanToolText(out.text ?? "") };
  }
}
