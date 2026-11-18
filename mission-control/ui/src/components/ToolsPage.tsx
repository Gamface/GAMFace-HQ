import { useEffect, useState } from "react";
import { getJson, send } from "../api";

// Tools: the MCP servers in tools/tools.json, run by the tools container. Jarvis Tools
// uses them on cards. Read-only tools just run; tools that change things ask you first
// (and routines never get them). Read-only tools can be tried here.

interface Param {
  type?: string;
  description?: string;
  enum?: unknown[];
}
interface Tool {
  server: string;
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema?: { properties?: Record<string, Param>; required?: string[] };
  annotations?: { destructiveHint?: boolean };
}
interface Server {
  name: string;
  description: string;
  ok: boolean;
  error?: string;
  tools: Tool[];
}
interface ToolsReply {
  enabled: boolean;
  servers: Server[];
  error?: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");
const input = "w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-cyan-500";

function Badge({ tool }: { tool: Tool }) {
  if (tool.readOnly) return <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px]">read-only</span>;
  const destructive = tool.annotations?.destructiveHint !== false;
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] ${destructive ? "bg-rose-900/70 text-rose-200" : "bg-amber-900/70 text-amber-200"}`}
      title={destructive ? "May delete or overwrite: always asks" : "Asks before each call"}
    >
      {destructive ? "changes things · always asks" : "changes things · asks"}
    </span>
  );
}

/** One tool: its parameters and, for read-only tools, a form to try it. */
function ToolRow({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; isError: boolean; ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const props = Object.entries(tool.inputSchema?.properties ?? {});
  const required = new Set(tool.inputSchema?.required ?? []);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const args: Record<string, unknown> = {};
      for (const [name, p] of props) {
        const raw = (values[name] ?? "").trim();
        if (!raw) continue;
        args[name] = p.type === "number" || p.type === "integer" ? Number(raw) : p.type === "boolean" ? raw === "true" : raw;
      }
      setResult(await send<{ text: string; isError: boolean; ms: number }>("POST", "/api/tools/call", { server: tool.server, tool: tool.name, args }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-t border-slate-800 first:border-t-0 py-2">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-start gap-2 text-left">
        <span className="text-slate-500 text-xs mt-0.5 w-3">{open ? "▾" : "▸"}</span>
        <span className="font-mono text-xs text-slate-200 shrink-0">{tool.name}</span>
        <span className="text-xs text-slate-500 flex-1 min-w-0 truncate">{tool.description}</span>
        <Badge tool={tool} />
      </button>
      {open && (
        <div className="ml-5 mt-2 space-y-2">
          <p className="text-xs text-slate-400 whitespace-pre-wrap">{tool.description}</p>
          {props.length === 0 && <p className="text-[11px] text-slate-500">No parameters.</p>}
          {props.length > 0 && (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {props.map(([name, p]) => (
                <label key={name} className="text-[11px] text-slate-400 space-y-0.5">
                  <span>
                    <span className="font-mono text-slate-300">{name}</span>
                    {required.has(name) ? " (required)" : ""} · {p.enum ? "one of" : (p.type ?? "any")}
                    {p.description ? ` · ${p.description}` : ""}
                  </span>
                  {p.enum ? (
                    <select value={values[name] ?? ""} onChange={(e) => setValues({ ...values, [name]: e.target.value })} className={input} disabled={!tool.readOnly}>
                      <option value="">(not set)</option>
                      {p.enum.map((v) => (
                        <option key={String(v)} value={String(v)}>
                          {String(v)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input value={values[name] ?? ""} onChange={(e) => setValues({ ...values, [name]: e.target.value })} className={input} disabled={!tool.readOnly} />
                  )}
                </label>
              ))}
            </div>
          )}
          {tool.readOnly ? (
            <button onClick={() => void run()} disabled={busy} className="px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium disabled:opacity-50">
              {busy ? "Running…" : "Try it"}
            </button>
          ) : (
            <p className="text-[11px] text-amber-300/90">Tools that change things can't be tried here. On a card, Jarvis Tools asks you before each call.</p>
          )}
          {error && <p className="text-xs text-rose-300">{error}</p>}
          {result && (
            <div className="space-y-1">
              <p className={`text-[11px] ${result.isError ? "text-rose-300" : "text-emerald-300"}`}>
                {result.isError ? "The tool reported an error" : "Done"} · {result.ms} ms
              </p>
              <pre className="text-[11px] text-slate-300 bg-slate-950 border border-slate-800 rounded p-2 max-h-80 overflow-auto whitespace-pre-wrap">{result.text || "(empty)"}</pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default function ToolsPage() {
  const [data, setData] = useState<ToolsReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (fresh = false) => {
    setBusy(true);
    return getJson<ToolsReply>(`/api/tools${fresh ? "?fresh=1" : ""}`)
      .then((d) => {
        setData(d);
        setError(d.error ?? null);
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    void load();
  }, []);

  const total = data?.servers.reduce((n, s) => n + s.tools.length, 0) ?? 0;
  return (
    <div className="col-span-3 min-h-0 overflow-y-auto space-y-4 pr-1">
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-200">Tools</h2>
          <p className="text-xs text-slate-500">
            Outside tools Jarvis Tools can use on cards (MCP servers in <span className="font-mono">tools/tools.json</span>). Read-only tools just run; tools that change things ask you before
            each call, and routines only get read-only tools. Set how approvals work on the Team page.
          </p>
          <button onClick={() => void load(true)} disabled={busy} className="ml-auto shrink-0 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs disabled:opacity-50">
            {busy ? "Checking…" : "Check again"}
          </button>
        </div>
        {data && !data.enabled && <p className="text-xs text-amber-300">No tools service is set up (TOOLS_URL). Start the tools container: docker compose up -d tools</p>}
        {data?.enabled && <p className="text-xs text-slate-400">{data.servers.length} servers · {total} tools</p>}
        {error && <p className="text-xs text-rose-300">{error}</p>}
        <p className="text-[11px] text-slate-500">
          To add a tool: install its program in <span className="font-mono">tools/Dockerfile</span>, list it in <span className="font-mono">tools/tools.json</span>, put any key it needs in{" "}
          <span className="font-mono">tools/.env</span>, then <span className="font-mono">docker compose up -d --build tools</span>.
        </p>
      </section>

      {!data && !error && <p className="text-slate-500 text-sm px-1">Loading tools…</p>}
      {data?.servers.map((s) => (
        <section key={s.name} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${s.ok ? "bg-emerald-400" : "bg-rose-500"}`} />
            <h3 className="text-sm font-semibold text-slate-200 font-mono">{s.name}</h3>
            <span className="text-xs text-slate-500">{s.tools.length} tools</span>
          </div>
          {s.description && <p className="text-xs text-slate-400 mt-1">{s.description}</p>}
          {!s.ok && <p className="text-xs text-rose-300 mt-1">Not running: {s.error}</p>}
          {s.tools.length > 0 && (
            <ul className="mt-2">
              {s.tools.map((t) => (
                <ToolRow key={t.name} tool={t} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
