import { useEffect, useState } from "react";
import { getJson } from "../api";
import { useProjects } from "../project";
import ChangeList from "./ChangeList";
import type { ChangeSummary } from "./ChangeList";

// The project's workspace (the folder the Coder and File agents edit) and the history of
// every change the agents made, with diffs and Undo.

interface Tree {
  name: string;
  root: string;
  exists: boolean;
  files: { path: string; bytes: number }[];
  truncated: boolean;
}

export default function FilesPage() {
  const proj = useProjects();
  const [tree, setTree] = useState<Tree | null>(null);
  const [history, setHistory] = useState<ChangeSummary[]>([]);
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = proj.target ? `project=${proj.target}` : "project=general";
  const load = () => {
    getJson<Tree>(`/api/workspace?${q}`)
      .then(setTree)
      .catch((e) => setError(String(e)));
    getJson<ChangeSummary[]>(`/api/changes?${proj.view === "all" ? "" : q}&limit=100`)
      .then(setHistory)
      .catch((e) => setError(String(e)));
  };
  useEffect(() => {
    setFile(null);
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj.view]);
  const open = (p: string) =>
    getJson<{ path: string; text: string }>(`/api/workspace/file?${q}&path=${encodeURIComponent(p)}`)
      .then(setFile)
      .catch((e) => setError(String(e)));
  const projectName = proj.byId(proj.target)?.name ?? "General";

  return (
    <div className="col-span-3 min-h-0 grid grid-cols-2 gap-4">
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 min-h-0 min-w-0 flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Change history{proj.view === "all" ? " (all projects)" : ` · ${projectName}`}</h2>
          <p className="text-xs text-slate-500">
            Every file the agents created, changed or deleted, newest first. Undo puts the files back as they were; undoing an undo redoes it.
          </p>
        </div>
        {error && <p className="text-xs text-rose-300">{error}</p>}
        <div className="overflow-y-auto min-h-0 pr-1">
          {history.length ? <ChangeList list={history} onChanged={load} showCard /> : <p className="text-sm text-slate-500 italic">No changes yet. Tick “Edit files in the workspace” on a card to let the Coder or File agent change files.</p>}
        </div>
      </section>
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 min-h-0 min-w-0 flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Workspace “{tree?.name ?? "…"}”</h2>
          <p className="text-xs text-slate-500">
            {projectName}'s folder for agents to edit{tree ? <code className="ml-1 text-slate-400">{tree.root}</code> : null}. Set a different folder (for example a repo you mounted) in the project's settings.
          </p>
        </div>
        <div className="grid grid-cols-[13rem_1fr] gap-3 min-h-0 flex-1">
          <nav className="overflow-y-auto min-h-0 text-xs font-mono space-y-0.5 pr-1">
            {!tree?.files.length && <p className="text-slate-500 font-sans italic">Empty.</p>}
            {tree?.files.map((f) => (
              <button key={f.path} onClick={() => void open(f.path)} className={`block w-full text-left truncate px-1.5 py-0.5 rounded ${file?.path === f.path ? "bg-slate-700 text-white" : "text-slate-300 hover:bg-slate-800"}`} title={`${f.path} · ${f.bytes} B`}>
                {f.path}
              </button>
            ))}
            {tree?.truncated && <p className="text-slate-500 font-sans">…and more</p>}
          </nav>
          <div className="min-h-0 overflow-auto bg-slate-950 border border-slate-800 rounded-md">
            {file ? (
              <pre className="text-[11px] leading-snug font-mono p-3 text-slate-200 whitespace-pre">{file.text}</pre>
            ) : (
              <p className="p-3 text-xs text-slate-500">Pick a file to look at it.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
