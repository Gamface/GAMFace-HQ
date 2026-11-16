import { useEffect, useState, useSyncExternalStore } from "react";
import { AGENT_LABELS, getJson, send } from "../api";

// Model presets: saved team setups (which model each agent uses), switched in one click.

export interface Preset {
  id: string;
  name: string;
  models: Record<string, { model: string; fallback?: string }>;
  builtIn?: boolean;
}
interface Reply {
  presets: Preset[];
  active: string | null;
}

// Shared between the header picker and the Team page
let state: Reply = { presets: [], active: null };
const listeners = new Set<() => void>();
export function reloadPresets() {
  return getJson<Reply>("/api/presets")
    .then((r) => {
      state = r;
      listeners.forEach((l) => l());
    })
    .catch(() => {});
}
export function usePresets(): Reply {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

type ApplyResult = { applied: string[]; skipped: { role: string; reason: string }[] };
const label = (r: string) => AGENT_LABELS[r] ?? r;
const short = (ref: string) => ref.replace(/^ollama\//, "");

/** Switches the team to a preset; returns a sentence about anything kept. */
export async function applyPreset(id: string): Promise<string | null> {
  const out = await send<ApplyResult>("POST", `/api/presets/${id}/apply`, {});
  await reloadPresets();
  // The Team page's table reloads too
  window.dispatchEvent(new Event("mc:models-changed"));
  return out.skipped.length ? `Kept their models: ${out.skipped.map((s) => `${label(s.role)} (${s.reason})`).join(", ")}` : null;
}

/** Header dropdown: the active preset, or "Custom setup". */
export function PresetPicker({ model, onChanged }: { model?: string; onChanged?: () => void }) {
  const { presets, active } = usePresets();
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void reloadPresets();
    const t = setInterval(() => void reloadPresets(), 10_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);
  return (
    <span className="relative">
      <label className="flex items-center gap-1 bg-slate-800 pl-3 pr-1 py-0.5 rounded-md border border-slate-700" title={`Jarvis: ${model ?? "—"}. Pick a preset to switch every agent's model.`}>
        <span className="text-slate-400">Models:</span>
        <select
          value={active ?? ""}
          onChange={async (e) => {
            const v = e.target.value;
            if (v === "__save") {
              const name = prompt("Name for the current setup (for example: Best quality)");
              if (name?.trim()) {
                try {
                  await send("POST", "/api/presets", { name: name.trim() });
                  await reloadPresets();
                } catch (err) {
                  setNote(err instanceof Error ? err.message : String(err));
                }
              }
              return;
            }
            if (!v) return;
            try {
              setNote(await applyPreset(v));
              onChanged?.();
            } catch (err) {
              setNote(err instanceof Error ? err.message : String(err));
            }
          }}
          className="bg-transparent text-slate-100 py-0.5 focus:outline-none max-w-[12rem]"
          aria-label="Model preset"
        >
          {!active && <option value="">Custom ({short(model ?? "—")})</option>}
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {!active && <option value="__save">Save this setup as a preset…</option>}
        </select>
      </label>
      {note && <span className="absolute right-0 top-9 z-50 w-72 text-xs font-sans whitespace-normal bg-slate-800 border border-amber-700 text-amber-200 rounded-md px-2 py-1 shadow-xl">{note}</span>}
    </span>
  );
}

/** Team page: the presets, with apply, save, update, rename and delete. */
export function PresetsSection({ onApplied }: { onApplied: () => void }) {
  const { presets, active } = usePresets();
  const [status, setStatus] = useState<string | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    void reloadPresets();
  }, []);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setStatus(null);
    try {
      const out = await fn();
      await reloadPresets();
      setStatus(typeof out === "string" ? out : (done ?? null));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-slate-200">Presets</h2>
        <p className="text-xs text-slate-500 flex-1">
          Saved team setups. Apply one to switch every agent at once (local-only agents keep a local model), say “use preset fast” in a card or on Telegram, or pin one to a project in its settings.
        </p>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        {presets.map((p) => (
          <div key={p.id} className={`border rounded-lg p-3 text-xs ${active === p.id ? "border-cyan-700 bg-slate-950/60" : "border-slate-800"}`}>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-slate-100">{p.name}</span>
              {p.builtIn && <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px]">built in</span>}
              {active === p.id && <span className="px-1.5 py-0.5 rounded bg-cyan-900 text-cyan-200 text-[10px]">in use</span>}
              <div className="ml-auto flex gap-1">
                {active !== p.id && (
                  <button
                    onClick={() =>
                      void act(async () => {
                        const kept = await applyPreset(p.id);
                        onApplied();
                        return kept ?? `Switched to “${p.name}”.`;
                      })
                    }
                    className="px-2 py-1 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white"
                  >
                    Apply
                  </button>
                )}
                {!p.builtIn && (
                  <>
                    <button onClick={() => void act(() => send("PATCH", `/api/presets/${p.id}`, { fromCurrent: true }), `“${p.name}” now holds the current setup.`)} className="px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200" title="Replace its models with the team's current ones">
                      Update
                    </button>
                    <button
                      onClick={() => {
                        const n = prompt("New name", p.name);
                        if (n?.trim() && n.trim() !== p.name) void act(() => send("PATCH", `/api/presets/${p.id}`, { name: n.trim() }));
                      }}
                      className="px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200"
                    >
                      Rename
                    </button>
                    <button onClick={() => confirm(`Delete the preset “${p.name}”?`) && void act(() => send("DELETE", `/api/presets/${p.id}`))} className="px-2 py-1 rounded-md bg-slate-800 hover:bg-rose-900 text-slate-200">
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-slate-400 font-mono text-[11px]">
              {Object.entries(p.models).map(([r, m]) => (
                <span key={r}>
                  <span className="text-slate-500 font-sans">{label(r)}</span> {m.model.startsWith("ollama/") ? short(m.model) : `☁ ${m.model}`}
                  {m.fallback ? <span className="text-slate-600"> → {short(m.fallback)}</span> : null}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Name (for example: Best quality)" className="bg-slate-950 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-slate-200 w-72" />
        <button
          disabled={!name.trim()}
          onClick={() =>
            void act(async () => {
              await send("POST", "/api/presets", { name: name.trim() });
              setName("");
            }, "Saved.")
          }
          className="px-3 py-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm disabled:opacity-40"
        >
          Save the current setup as a preset
        </button>
        {status && <span className="text-xs text-slate-300">{status}</span>}
      </div>
    </section>
  );
}
