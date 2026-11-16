import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AGENT_LABELS, getJson, send } from "../api";

// Skills: reusable procedures the agents follow when a request fits. Drafts come
// from finished cards (written by a local model) and do nothing until you approve
// them. Skills you add yourself are on straight away.

interface Skill {
  id: string;
  name: string;
  description: string;
  agents: string[];
  steps: string;
  status: "draft" | "active" | "off";
  private: boolean;
  sourceTitle?: string;
  replaces?: string;
  uses: number;
  lastUsedAt?: number;
  updatedAt: number;
}
type Fields = Pick<Skill, "name" | "description" | "agents" | "steps">;

const AGENTS = ["planner", "coder", "browser", "file", "security_audit", "vision"];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");
const input = "w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";

function SkillForm({ initial, saveLabel, onSave, onCancel, extra }: { initial: Fields; saveLabel: string; onSave: (f: Fields) => Promise<void>; onCancel?: () => void; extra?: ReactNode }) {
  const [f, setF] = useState<Fields>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSave(f);
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name (3–6 words)" maxLength={60} className={input} required />
        <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="When to use it (one sentence)" maxLength={300} className={input} required />
      </div>
      <textarea value={f.steps} onChange={(e) => setF({ ...f, steps: e.target.value })} rows={6} maxLength={4000} placeholder={"1. …\n2. …"} className={`${input} font-mono text-xs`} required />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-400">Used by:</span>
        {AGENTS.map((a) => (
          <label key={a} className="flex items-center gap-1 text-slate-300">
            <input
              type="checkbox"
              checked={f.agents.includes(a)}
              onChange={(e) => setF({ ...f, agents: e.target.checked ? [...f.agents, a] : f.agents.filter((x) => x !== a) })}
            />
            {AGENT_LABELS[a] ?? a}
          </label>
        ))}
        <span className="text-slate-500">(none ticked: any agent)</span>
        <div className="ml-auto flex gap-2">
          {extra}
          {onCancel && (
            <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300">
              Cancel
            </button>
          )}
          <button type="submit" disabled={busy} className="px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white font-medium disabled:opacity-50">
            {busy ? "Saving…" : saveLabel}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </form>
  );
}

export default function SkillsPage() {
  const [list, setList] = useState<Skill[] | null>(null);
  const [auto, setAuto] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    getJson<{ skills: Skill[]; auto: boolean }>("/api/skills")
      .then((d) => {
        setList(d.skills);
        setAuto(d.auto);
      })
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errText(e));
    }
  };
  if (!list) return <div className="col-span-3 p-6 text-slate-500">{error ?? "Loading skills…"}</div>;
  const drafts = list.filter((s) => s.status === "draft");
  const rest = list.filter((s) => s.status !== "draft");
  const nameOf = (id?: string) => list.find((s) => s.id === id)?.name;

  return (
    <div className="col-span-3 min-h-0 overflow-y-auto space-y-4 pr-1">
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-200">Skills</h2>
          <p className="text-xs text-slate-500">
            Procedures the agents follow when a request fits, matched by its words. They learn them from finished work; nothing is used until you approve it.
          </p>
          {!adding && (
            <button onClick={() => setAdding(true)} className="ml-auto px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium">
              + New skill
            </button>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={auto} onChange={(e) => void act(() => send("PUT", "/api/skills/settings", { auto: e.target.checked }))} />
          Draft skills automatically after complex cards (teamwork, 4+ browser steps, or a back-and-forth). Drafts are written by your local Memory model when nothing else is running. You can also press ✨ Make a skill on any finished card.
        </label>
        {error && <p className="text-xs text-rose-300">{error}</p>}
      </section>

      {adding && (
        <section className="bg-slate-900 border border-cyan-800/60 rounded-xl p-4">
          <SkillForm
            initial={{ name: "", description: "", agents: [], steps: "" }}
            saveLabel="Add skill"
            onCancel={() => setAdding(false)}
            onSave={async (f) => {
              await send("POST", "/api/skills", f);
              setAdding(false);
              await load();
            }}
          />
        </section>
      )}

      {drafts.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-violet-300 px-1">Waiting for your review ({drafts.length})</h3>
          {drafts.map((s) => (
            <div key={s.id} className="bg-slate-900 border border-violet-700/60 rounded-xl p-4 space-y-2">
              <p className="text-[11px] text-slate-400">
                ✨ Drafted from “{s.sourceTitle ?? "a card"}”
                {s.replaces && <span className="text-amber-300"> · would update the skill “{nameOf(s.replaces)}”</span>}
                {s.private && <span> · 🔒 private (learned from private material; never sent to cloud models)</span>}
              </p>
              <SkillForm
                initial={s}
                saveLabel={s.replaces ? "Approve update" : "Approve"}
                onSave={async (f) => {
                  await send("PATCH", `/api/skills/${s.id}`, { ...f, status: "active" });
                  await load();
                }}
                extra={
                  <button
                    type="button"
                    onClick={() => void act(() => send("DELETE", `/api/skills/${s.id}`))}
                    className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-rose-900 text-slate-300"
                  >
                    Discard
                  </button>
                }
              />
            </div>
          ))}
        </section>
      )}

      {rest.length === 0 && drafts.length === 0 && !adding && (
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-sm text-slate-400">
          No skills yet. They'll appear here as drafts after complex cards, or press ✨ Make a skill on a finished card.
        </section>
      )}

      {rest.map((s) =>
        editing === s.id ? (
          <section key={s.id} className="bg-slate-900 border border-cyan-800/60 rounded-xl p-4">
            <SkillForm
              initial={s}
              saveLabel="Save"
              onCancel={() => setEditing(null)}
              onSave={async (f) => {
                await send("PATCH", `/api/skills/${s.id}`, f);
                setEditing(null);
                await load();
              }}
            />
          </section>
        ) : (
          <section key={s.id} className={`bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2 ${s.status === "off" ? "opacity-60" : ""}`}>
            <div className="flex items-center gap-3">
              <span className="text-lg">🧩</span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-100">
                  {s.name} {s.private && <span title="Private: never sent to cloud models">🔒</span>}
                </h3>
                <p className="text-xs text-slate-400">{s.description}</p>
              </div>
              <div className="ml-auto flex items-center gap-2 text-xs shrink-0">
                <span className="text-slate-500">
                  {s.agents.length ? s.agents.map((a) => AGENT_LABELS[a] ?? a).join(", ") : "any agent"} · used {s.uses}×
                  {s.lastUsedAt ? `, last ${new Date(s.lastUsedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                </span>
                <label className="flex items-center gap-1.5 text-slate-300">
                  <input type="checkbox" checked={s.status === "active"} onChange={(e) => void act(() => send("PATCH", `/api/skills/${s.id}`, { status: e.target.checked ? "active" : "off" }))} />
                  On
                </label>
                <button onClick={() => setEditing(s.id)} className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300">
                  Edit
                </button>
                <button
                  onClick={() => confirm(`Delete the skill “${s.name}”?`) && void act(() => send("DELETE", `/api/skills/${s.id}`))}
                  className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-rose-900 text-slate-400"
                >
                  Delete
                </button>
              </div>
            </div>
            <pre className="text-xs text-slate-300 bg-slate-950/60 rounded-md px-3 py-2 whitespace-pre-wrap font-mono">{s.steps}</pre>
          </section>
        ),
      )}
    </div>
  );
}
