import { setProject, useProjects } from "../project";

/** Header dropdown: which project the board, assets, skills and routines show. */
export default function ProjectSwitcher({ onManage }: { onManage: () => void }) {
  const { view, active, byId } = useProjects();
  const cur = byId(view);
  return (
    <label className="ml-3 flex items-center gap-1.5 text-xs bg-slate-800 border border-slate-700 rounded-md pl-2" title="Project: new cards, assets, skills and routines go in it">
      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: cur?.color ?? (view === "general" ? "#94a3b8" : "transparent"), border: view === "all" ? "1px solid #64748b" : undefined }} />
      <select
        value={view}
        onChange={(e) => (e.target.value === "__manage" ? onManage() : setProject(e.target.value))}
        className="bg-transparent py-1 pr-1 text-slate-200 max-w-[11rem] focus:outline-none"
        aria-label="Project"
      >
        <option value="all">All projects</option>
        <option value="general">General</option>
        {active.map((p) => (
          <option key={p.id} value={p.id}>
            {p.localOnly ? "🔒 " : ""}
            {p.name}
          </option>
        ))}
        <option value="__manage">Manage projects…</option>
      </select>
    </label>
  );
}
