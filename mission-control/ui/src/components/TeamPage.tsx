import { useEffect, useMemo, useState } from "react";
import { AGENT_LABELS, getJson, send, splitModel } from "../api";

// Pick a model for each agent: provider + model, an optional fallback, and
// per-agent settings. API keys stay in .env; this page only shows whether one is set.

interface RoleSettings {
  model: string;
  fallback?: string;
  numCtx?: number;
  temperature?: number;
  think?: boolean;
  dailyTokenLimit?: number;
  localOnly?: boolean;
  allowPrivateToCloud?: boolean;
  monthlyBudgetUsd?: number;
}
interface Price {
  input: number;
  output: number;
}
interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv?: string;
  local?: boolean;
}
interface ProviderInfo {
  id: string;
  name: string;
  kind: string;
  local: boolean;
  baseUrl: string;
  apiKeyEnv?: string;
  keySet: boolean | null;
}
interface ModelsReply {
  settings: {
    roles: Record<string, RoleSettings>;
    aliases: Record<string, string>;
    customProviders: CustomProvider[];
    prices: Record<string, Price>;
    monthlyBudgetUsd?: number;
  };
  spendThisMonth: Record<string, number>;
  spendTotalThisMonth: number;
  resolved: Record<string, string>;
  providers: ProviderInfo[];
  usage: { agent: string; model: string; prompt_tokens: number; completion_tokens: number; requests: number; errors: number }[];
}

const ROLES: { key: string; what: string }[] = [
  { key: "planner", what: "Leads, plans and delegates" },
  { key: "coder", what: "Writes and reviews code" },
  { key: "browser", what: "Decides each browsing step" },
  { key: "file", what: "Notes, vault and files" },
  { key: "security_audit", what: "Defensive reviews" },
  { key: "router", what: "Picks the agent for auto tasks (fast model)" },
  { key: "memory", what: "Extracts memories between tasks (fast model)" },
];

const input = "bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-cyan-500";

function ModelPicker({
  value,
  onChange,
  providers,
  available,
  loadModels,
  allowNone,
}: {
  value: string;
  onChange: (v: string) => void;
  providers: ProviderInfo[];
  available: Record<string, string[]>;
  loadModels: (p: string) => void;
  allowNone?: boolean;
}) {
  const { provider, name } = splitModel(value);
  const prov = value ? provider : "";
  useEffect(() => {
    if (prov) loadModels(prov);
  }, [prov]);
  const list = available[prov] ?? [];
  const listId = `models-${prov}`;
  return (
    <div className="flex gap-1">
      <select
        className={`${input} w-32`}
        value={prov}
        onChange={(e) => {
          const p = e.target.value;
          if (!p) return onChange("");
          loadModels(p);
          onChange(`${p}/${(available[p] ?? [])[0] ?? ""}`);
        }}
      >
        {allowNone && <option value="">— none —</option>}
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.local ? "🖥 " : "☁ "}
            {p.id}
          </option>
        ))}
      </select>
      {prov && (
        <>
          <input list={listId} className={`${input} flex-1 font-mono min-w-0`} value={name} onChange={(e) => onChange(`${prov}/${e.target.value}`)} placeholder="model name" />
          <datalist id={listId}>
            {list.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}

export default function TeamPage() {
  const [data, setData] = useState<ModelsReply | null>(null);
  const [roles, setRoles] = useState<Record<string, RoleSettings>>({});
  const [aliases, setAliases] = useState<[string, string][]>([]);
  const [custom, setCustom] = useState<CustomProvider[]>([]);
  const [prices, setPrices] = useState<Record<string, Price>>({});
  const [overallCap, setOverallCap] = useState<number | undefined>(undefined);
  const [available, setAvailable] = useState<Record<string, string[]>>({});
  const [checks, setChecks] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = () =>
    getJson<ModelsReply>("/api/models").then((d) => {
      setData(d);
      setRoles(d.settings.roles);
      setAliases(Object.entries(d.settings.aliases));
      setCustom(d.settings.customProviders);
      setPrices(d.settings.prices ?? {});
      setOverallCap(d.settings.monthlyBudgetUsd);
      setDirty(false);
    });

  useEffect(() => {
    void load();
    getJson<{ id: string; ok: boolean; detail: string }[]>("/api/models/check")
      .then((rows) => setChecks(Object.fromEntries(rows.map((r) => [r.id, r]))))
      .catch(() => {});
  }, []);

  const loadModels = (p: string) => {
    if (available[p]) return;
    setAvailable((a) => ({ ...a, [p]: [] }));
    getJson<{ models: string[] }>(`/api/models/available?provider=${encodeURIComponent(p)}`)
      .then((r) => setAvailable((a) => ({ ...a, [p]: r.models })))
      .catch(() => {});
  };

  const usageByRole = useMemo(() => {
    const m: Record<string, { tokens: number; requests: number; errors: number }> = {};
    for (const u of data?.usage ?? []) {
      const e = (m[u.agent] ??= { tokens: 0, requests: 0, errors: 0 });
      e.tokens += u.prompt_tokens + u.completion_tokens;
      e.requests += u.requests;
      e.errors += u.errors;
    }
    return m;
  }, [data]);

  const setRole = (role: string, patch: Partial<RoleSettings>) => {
    setRoles((r) => ({ ...r, [role]: { ...r[role], ...patch } }));
    setDirty(true);
  };

  const save = async () => {
    try {
      const cleanRoles = Object.fromEntries(
        Object.entries(roles).map(([k, v]) => [
          k,
          {
            ...v,
            fallback: v.fallback || undefined,
            dailyTokenLimit: v.dailyTokenLimit || undefined,
            monthlyBudgetUsd: v.monthlyBudgetUsd === undefined || Number.isNaN(v.monthlyBudgetUsd) ? undefined : v.monthlyBudgetUsd,
          },
        ]),
      );
      await send("PUT", "/api/models", {
        roles: cleanRoles,
        aliases: Object.fromEntries(aliases.filter(([a, r]) => a.trim() && r.trim()).map(([a, r]) => [a.trim().toLowerCase(), r.trim()])),
        customProviders: custom,
        prices,
        monthlyBudgetUsd: overallCap === undefined || Number.isNaN(overallCap) ? undefined : overallCap,
      });
      setStatus({ ok: true, text: "Saved. New tasks use these models." });
      await load();
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!data) return <div className="col-span-3 p-6 text-slate-500">Loading team…</div>;
  const providers = data.providers;
  const isLocal = (ref?: string) => providers.find((p) => p.id === splitModel(ref).provider)?.local ?? true;
  // Cloud models in use need a price for their spend to be capped
  const cloudRefs = [...new Set([...Object.values(roles).flatMap((r) => [r.model, r.fallback ?? ""]), ...Object.keys(prices)])].filter((r) => r && !isLocal(r)).sort();
  const money = (x?: number) => (x === undefined ? "—" : x > 0 && x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);

  return (
    <div className="col-span-3 min-h-0 overflow-y-auto space-y-4 pr-1">
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-sm font-semibold text-slate-200">Agent models</h2>
          <p className="text-xs text-slate-500">Each agent can use a different model. Local models swap on the GPU, so the queue groups same-model work.</p>
          <div className="ml-auto flex items-center gap-2">
            {status && <span className={`text-xs ${status.ok ? "text-emerald-400" : "text-rose-300"}`}>{status.text}</span>}
            <button onClick={() => void save()} disabled={!dirty} className="px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium disabled:opacity-40">
              Save
            </button>
          </div>
        </div>
        <table className="w-full text-xs">
          <thead className="text-slate-500 text-left">
            <tr>
              <th className="py-1 font-medium w-40">Agent</th>
              <th className="font-medium">Model</th>
              <th className="font-medium">Fallback (if it fails)</th>
              <th className="font-medium w-20">Context</th>
              <th className="font-medium w-16">Temp</th>
              <th className="font-medium w-14">Think</th>
              <th className="font-medium w-16" title="Never send this agent's requests to a cloud model">Local only</th>
              <th className="font-medium w-20" title="Let vault notes, memories and the hive log go to its cloud model">Private → cloud</th>
              <th className="font-medium w-24">Monthly $ cap</th>
              <th className="font-medium w-28">Daily token cap</th>
              <th className="font-medium w-28 text-right">Today / month</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map(({ key, what }) => {
              const r = roles[key];
              if (!r) return null;
              const u = usageByRole[key];
              const capped = data.resolved[key] !== r.model;
              return (
                <tr key={key} className="border-t border-slate-800 align-top">
                  <td className="py-2 pr-2">
                    <div className="text-slate-200 font-medium">{AGENT_LABELS[key]}</div>
                    <div className="text-[10px] text-slate-500">{what}</div>
                    {capped && <div className="text-[10px] text-amber-300">using fallback: {data.resolved[key]}</div>}
                  </td>
                  <td className="py-2 pr-2">
                    <ModelPicker value={r.model} onChange={(v) => setRole(key, { model: v })} providers={providers} available={available} loadModels={loadModels} />
                  </td>
                  <td className="py-2 pr-2">
                    <ModelPicker value={r.fallback ?? ""} onChange={(v) => setRole(key, { fallback: v })} providers={providers} available={available} loadModels={loadModels} allowNone />
                  </td>
                  <td className="py-2 pr-2">
                    <input type="number" className={`${input} w-20`} value={r.numCtx ?? ""} step={1024} min={512} onChange={(e) => setRole(key, { numCtx: e.target.value ? Number(e.target.value) : undefined })} />
                  </td>
                  <td className="py-2 pr-2">
                    <input type="number" className={`${input} w-16`} value={r.temperature ?? ""} step={0.1} min={0} max={2} placeholder="def" onChange={(e) => setRole(key, { temperature: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </td>
                  <td className="py-2 pr-2">
                    <input type="checkbox" checked={Boolean(r.think)} onChange={(e) => setRole(key, { think: e.target.checked })} title="Let reasoning models think first (slower)" />
                  </td>
                  <td className="py-2 pr-2 text-center">
                    <input
                      type="checkbox"
                      checked={Boolean(r.localOnly)}
                      onChange={(e) => setRole(key, { localOnly: e.target.checked })}
                      title="Checked on every request: this agent never reaches a cloud provider"
                    />
                    {r.localOnly && <div className="text-[10px] text-emerald-400">🔒</div>}
                  </td>
                  <td className="py-2 pr-2 text-center">
                    {isLocal(r.model) && isLocal(r.fallback) ? (
                      <span className="text-slate-600">—</span>
                    ) : (
                      <>
                        <input type="checkbox" checked={Boolean(r.allowPrivateToCloud)} onChange={(e) => setRole(key, { allowPrivateToCloud: e.target.checked })} />
                        <div className={`text-[10px] ${r.allowPrivateToCloud ? "text-amber-300" : "text-slate-500"}`}>{r.allowPrivateToCloud ? "sent" : "withheld"}</div>
                      </>
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    {isLocal(r.model) ? (
                      <span className="text-slate-600">local: free</span>
                    ) : (
                      <input
                        type="number"
                        className={`${input} w-24`}
                        value={r.monthlyBudgetUsd ?? ""}
                        step={1}
                        min={0}
                        placeholder="no cap"
                        onChange={(e) => setRole(key, { monthlyBudgetUsd: e.target.value === "" ? undefined : Number(e.target.value) })}
                      />
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    {isLocal(r.model) ? (
                      <span className="text-slate-600">local: none</span>
                    ) : (
                      <input type="number" className={`${input} w-28`} value={r.dailyTokenLimit ?? ""} step={10000} min={0} placeholder="no cap" onChange={(e) => setRole(key, { dailyTokenLimit: e.target.value ? Number(e.target.value) : undefined })} />
                    )}
                  </td>
                  <td className="py-2 text-right text-slate-400 font-mono">
                    {u ? `${u.tokens.toLocaleString()} tok` : "—"}
                    {u && <div className="text-[10px] text-slate-600">{u.requests} calls{u.errors ? `, ${u.errors} failed` : ""}</div>}
                    {(data.spendThisMonth[key] ?? 0) > 0 && (
                      <div className={`text-[10px] ${r.monthlyBudgetUsd !== undefined && data.spendThisMonth[key] >= r.monthlyBudgetUsd ? "text-amber-300" : "text-slate-500"}`}>
                        {money(data.spendThisMonth[key])} this month
                        {r.monthlyBudgetUsd !== undefined ? ` / ${money(r.monthlyBudgetUsd)}` : ""}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-3 mb-1">
          <h2 className="text-sm font-semibold text-slate-200">Cloud spending</h2>
          <span className="text-xs text-slate-500">
            This month: <span className="text-slate-300 font-mono">{money(data.spendTotalThisMonth)}</span>
          </span>
          <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
            Overall monthly cap
            <input
              type="number"
              className={`${input} w-24`}
              value={overallCap ?? ""}
              min={0}
              step={1}
              placeholder="no cap"
              onChange={(e) => {
                setOverallCap(e.target.value === "" ? undefined : Number(e.target.value));
                setDirty(true);
              }}
            />
          </label>
        </div>
        <p className="text-xs text-slate-500 mb-3">
          Caps are checked before every cloud request (with an estimate of its cost) and count input and output tokens. When a cap is reached the agent uses its
          local model instead, the card says so, and a notice appears at the top. A capped agent on a model with no price also goes local.
        </p>
        {cloudRefs.length === 0 ? (
          <p className="text-xs text-slate-600">No cloud models in use.</p>
        ) : (
          <table className="text-xs">
            <thead className="text-slate-500 text-left">
              <tr>
                <th className="font-medium pr-4">Cloud model</th>
                <th className="font-medium pr-2">$ per 1M input tokens</th>
                <th className="font-medium">$ per 1M output tokens</th>
              </tr>
            </thead>
            <tbody>
              {cloudRefs.map((ref) => (
                <tr key={ref}>
                  <td className="pr-4 py-1 font-mono text-slate-300">
                    {ref} {!prices[ref] && <span className="text-amber-300 font-sans">(no price)</span>}
                  </td>
                  {(["input", "output"] as const).map((k) => (
                    <td key={k} className="pr-2 py-1">
                      <input
                        type="number"
                        min={0}
                        step={0.05}
                        className={`${input} w-24`}
                        value={prices[ref]?.[k] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value === "" ? NaN : Number(e.target.value);
                          setPrices((p) => {
                            const cur = p[ref] ?? { input: 0, output: 0 };
                            const next = { ...cur, [k]: Number.isNaN(v) ? 0 : v };
                            return { ...p, [ref]: next };
                          });
                          setDirty(true);
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid grid-cols-2 gap-4">
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-slate-200 mb-1">Providers</h2>
          <p className="text-xs text-slate-500 mb-3">
            Cloud providers appear when their key is in <code className="text-slate-400">.env</code>: OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY. LM
            Studio: LMSTUDIO_BASE_URL. Restart the harness after editing .env.
          </p>
          <div className="space-y-1.5 text-xs">
            {providers.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${checks[p.id] ? (checks[p.id].ok ? "bg-emerald-500" : "bg-rose-500") : "bg-slate-600"}`} />
                <span className="text-slate-200 w-24 font-mono">{p.id}</span>
                <span className="text-slate-400 flex-1 truncate">{p.name}</span>
                <span className="text-slate-500">{p.local ? "🖥 local" : "☁ cloud"}</span>
                <span className="text-slate-500 w-40 truncate text-right">{checks[p.id]?.detail ?? (p.apiKeyEnv ? `key: ${p.apiKeyEnv}` : "")}</span>
              </div>
            ))}
          </div>
          <h3 className="text-xs font-semibold text-slate-300 mt-4 mb-2">Custom OpenAI-compatible providers</h3>
          {custom.map((c, i) => (
            <div key={i} className="flex gap-1 mb-1">
              {(["id", "name", "baseUrl", "apiKeyEnv"] as const).map((f) => (
                <input
                  key={f}
                  className={`${input} ${f === "baseUrl" ? "flex-1" : "w-24"} min-w-0`}
                  placeholder={f === "apiKeyEnv" ? "KEY_ENV_NAME" : f}
                  value={c[f] ?? ""}
                  onChange={(e) => {
                    setCustom((list) => list.map((x, j) => (j === i ? { ...x, [f]: e.target.value } : x)));
                    setDirty(true);
                  }}
                />
              ))}
              <label className="flex items-center gap-1 text-[10px] text-slate-400">
                <input
                  type="checkbox"
                  checked={Boolean(c.local)}
                  onChange={(e) => {
                    setCustom((list) => list.map((x, j) => (j === i ? { ...x, local: e.target.checked } : x)));
                    setDirty(true);
                  }}
                />
                local
              </label>
              <button
                className="text-slate-500 hover:text-rose-400 px-1"
                onClick={() => {
                  setCustom((list) => list.filter((_, j) => j !== i));
                  setDirty(true);
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="text-xs text-cyan-400 hover:text-cyan-300"
            onClick={() => {
              setCustom((l) => [...l, { id: "", name: "", baseUrl: "http://", apiKeyEnv: "" }]);
              setDirty(true);
            }}
          >
            + Add provider (vLLM, Groq, a second Ollama…)
          </button>
        </section>

        <section className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-slate-200 mb-1">Model nicknames</h2>
          <p className="text-xs text-slate-500 mb-3">
            Say or type <code className="text-slate-400">switch to claude</code>, <code className="text-slate-400">switch coder to local</code> or{" "}
            <code className="text-slate-400">go local</code> in the dashboard, Telegram or voice.
          </p>
          {aliases.map(([a, r], i) => (
            <div key={i} className="flex gap-1 mb-1 items-center">
              <input
                className={`${input} w-28`}
                value={a}
                placeholder="nickname"
                onChange={(e) => {
                  setAliases((l) => l.map((x, j) => (j === i ? [e.target.value, x[1]] : x)));
                  setDirty(true);
                }}
              />
              <span className="text-slate-600">→</span>
              <input
                className={`${input} flex-1 font-mono`}
                value={r}
                placeholder="provider/model"
                onChange={(e) => {
                  setAliases((l) => l.map((x, j) => (j === i ? [x[0], e.target.value] : x)));
                  setDirty(true);
                }}
              />
              <button
                className="text-slate-500 hover:text-rose-400 px-1"
                onClick={() => {
                  setAliases((l) => l.filter((_, j) => j !== i));
                  setDirty(true);
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="text-xs text-cyan-400 hover:text-cyan-300"
            onClick={() => {
              setAliases((l) => [...l, ["", ""]]);
              setDirty(true);
            }}
          >
            + Add nickname
          </button>
        </section>
      </div>
    </div>
  );
}
