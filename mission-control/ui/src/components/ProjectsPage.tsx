import { useEffect, useState } from "react";
import { getJson, send } from "../api";
import { reloadProjects, setProject, useProjects } from "../project";
import type { ProjectInfo } from "../project";

// Projects: separate workspaces. Each has its own instructions, memories, activity
// log, skills, assets and brand, sign-ins and routines; General ones are shared.

const input = "w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";
const COLORS = ["#22d3ee", "#a78bfa", "#f472b6", "#fb923c", "#facc15", "#4ade80", "#60a5fa", "#f87171"];

interface Form {
  name: string;
  color: string;
  instructions: string;
  localOnly: boolean;
  profiles: string[];
}
const blank = (): Form => ({ name: "", color: COLORS[Math.floor(Math.random() * COLORS.length)], instructions: "", localOnly: false, profiles: [] });

function ProjectForm({
  start,
  profiles,
  owners,
  onSave,
  onCancel,
  saveLabel,
}: {
  start: Form;
  profiles: string[];
  owners: Record<string, string>;
  onSave: (f: Form) => Promise<void>;
  onCancel?: () => void;
  saveLabel: string;
}) {
  const [f, setF] = useState<Form>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} placeholder="Project name (e.g. Gamface)" className={input} />
        <div className="flex gap-1">
          {COLORS.map((c) => (
            <button key={c} onClick={() => setF({ ...f, color: c })} className={`h-6 w-6 rounded-full ${f.color === c ? "ring-2 ring-white" : ""}`} style={{ background: c }} aria-label={`Colour ${c}`} />
          ))}
        </div>
      </div>
      <textarea
        value={f.instructions}
        onChange={(e) => setF({ ...f, instructions: e.target.value })}
        rows={5}
        maxLength={4000}
        placeholder={"Instructions every agent follows on this project's cards. For example:\nGamface is a mobile gaming app for casual players. Write in a playful, upbeat voice. Our site is gamface.com; the repo is Gamface/GAMFace-HQ."}
        className={input}
      />
      <div className="flex flex-wrap gap-6 text-xs text-slate-300">
        <label className="flex items-start gap-2 max-w-sm">
          <input type="checkbox" checked={f.localOnly} onChange={(e) => setF({ ...f, localOnly: e.target.checked })} className="mt-0.5" />
          <span>
            <b>Keep on this PC.</b> Every model call for this project uses a local model, whatever the agents' settings say. Everything it learns stays in the project.
          </span>
        </label>
        <div className="space-y-1">
          <div className="text-slate-400">Browser sign-ins (profiles) only this project may use</div>
          {profiles.length === 0 && <div className="text-slate-500">No profiles yet (create them in the Browser tab).</div>}
          <div className="flex flex-wrap gap-2">
            {profiles.map((p) => {
              const taken = owners[p] && !start.profiles.includes(p);
              return (
                <label key={p} className={`flex items-center gap-1 px-2 py-1 rounded-md bg-slate-800 ${taken ? "opacity-50" : ""}`} title={taken ? `Belongs to ${owners[p]}` : undefined}>
                  <input
                    type="checkbox"
                    disabled={Boolean(taken)}
                    checked={f.profiles.includes(p)}
                    onChange={(e) => setF({ ...f, profiles: e.target.checked ? [...f.profiles, p] : f.profiles.filter((x) => x !== p) })}
                  />
                  {p}
                  {taken ? ` (${owners[p]})` : ""}
                </label>
              );
            })}
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex gap-2 justify-end">
        {onCancel && (
          <button onClick={onCancel} className="px-3 py-1.5 rounded-md text-sm text-slate-400 hover:text-slate-200">
            Cancel
          </button>
        )}
        <button
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSave({ ...f, name: f.name.trim(), instructions: f.instructions.trim() });
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy || !f.name.trim()}
          className="px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium disabled:opacity-40"
        >
          {busy ? "Saving…" : saveLabel}
        </button>
      </div>
    </div>
  );
}

function Counts({ p }: { p: ProjectInfo }) {
  const c = p.counts;
  const bits = [
    `${c.cards} card${c.cards === 1 ? "" : "s"}${c.open ? ` (${c.open} open)` : ""}`,
    `${c.memories} memor${c.memories === 1 ? "y" : "ies"}`,
    `${c.skills} skill${c.skills === 1 ? "" : "s"}`,
    `${c.assets} asset${c.assets === 1 ? "" : "s"}`,
    `${c.routines} routine${c.routines === 1 ? "" : "s"}`,
  ];
  return <span>{bits.join(" · ")}</span>;
}

export default function ProjectsPage() {
  const { projects, view } = useProjects();
  const [profiles, setProfiles] = useState<{ name: string; project: string | null }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void reloadProjects();
    getJson<{ profiles: { name: string; project: string | null }[] }>("/api/profiles")
      .then((r) => setProfiles(r.profiles))
      .catch(() => {});
  }, []);
  const names = profiles.map((p) => p.name);
  const owners = Object.fromEntries(profiles.filter((p) => p.project).map((p) => [p.name, projects.find((x) => x.id === p.project)?.name ?? "another project"]));
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reloadProjects();
      const r = await getJson<{ profiles: { name: string; project: string | null }[] }>("/api/profiles");
      setProfiles(r.profiles);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="col-span-3 min-h-0 overflow-y-auto space-y-4 pr-1">
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-200">Projects</h2>
          <p className="text-xs text-slate-500 flex-1">
            Separate workspaces. A project's cards get its instructions, and its memories, skills, assets, brand, sign-ins and routines stay inside it. Anything in General is shared with every project. Pick the project at the top of the page.
          </p>
          {!creating && (
            <button onClick={() => setCreating(true)} className="px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium">
              ＋ New project
            </button>
          )}
        </div>
        {creating && (
          <div className="border border-slate-700 rounded-xl p-3">
            <ProjectForm
              start={blank()}
              profiles={names}
              owners={owners}
              saveLabel="Create project"
              onCancel={() => setCreating(false)}
              onSave={async (f) => {
                const p = await send<ProjectInfo>("POST", "/api/projects", f);
                await reloadProjects();
                setProject(p.id);
                setCreating(false);
              }}
            />
          </div>
        )}
        {error && <p className="text-xs text-rose-300">{error}</p>}
        {projects.length === 0 && !creating && <div className="border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">No projects yet. Everything is in General.</div>}
        <div className="space-y-2">
          {projects.map((p) => (
            <div key={p.id} className={`border rounded-xl p-3 ${view === p.id ? "border-cyan-700 bg-slate-950/60" : "border-slate-800"} ${p.archived ? "opacity-60" : ""}`}>
              {editing === p.id ? (
                <ProjectForm
                  start={{ name: p.name, color: p.color, instructions: p.instructions, localOnly: p.localOnly, profiles: p.profiles }}
                  profiles={names}
                  owners={owners}
                  saveLabel="Save"
                  onCancel={() => setEditing(null)}
                  onSave={async (f) => {
                    await send("PATCH", `/api/projects/${p.id}`, f);
                    await act(async () => {});
                    setEditing(null);
                  }}
                />
              ) : (
                <div className="flex items-start gap-3">
                  <span className="h-3 w-3 mt-1.5 rounded-full shrink-0" style={{ background: p.color }} />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-100">{p.name}</span>
                      {p.localOnly && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900 text-emerald-200">🔒 kept on this PC</span>}
                      {p.archived && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">archived</span>}
                      {p.ownBrand && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">own brand</span>}
                    </div>
                    <div className="text-xs text-slate-400 line-clamp-2 whitespace-pre-wrap">{p.instructions || <i className="text-slate-600">No instructions</i>}</div>
                    <div className="text-[11px] text-slate-500">
                      <Counts p={p} />
                      {p.profiles.length ? ` · sign-ins: ${p.profiles.join(", ")}` : ""}
                    </div>
                  </div>
                  <div className="flex gap-1 text-xs shrink-0">
                    {!p.archived && view !== p.id && (
                      <button onClick={() => setProject(p.id)} className="px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200">
                        Open
                      </button>
                    )}
                    <button onClick={() => setEditing(p.id)} className="px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200">
                      Edit
                    </button>
                    <button onClick={() => void act(() => send("PATCH", `/api/projects/${p.id}`, { archived: !p.archived }))} className="px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200">
                      {p.archived ? "Restore" : "Archive"}
                    </button>
                    <button
                      onClick={() => confirm(`Delete the project “${p.name}”? Its memories and brand are deleted too. (It must have no cards, assets, skills or routines left.)`) && void act(() => send("DELETE", `/api/projects/${p.id}`))}
                      className="px-2 py-1 rounded-md bg-slate-800 hover:bg-rose-900 text-slate-200"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
