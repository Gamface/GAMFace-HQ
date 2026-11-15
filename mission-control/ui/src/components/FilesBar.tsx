import { useEffect, useState } from "react";
import { fileUrl, getJson, send } from "../api";
import type { CardFile } from "../api";

// A card's PDF reports, with a button to make one from the answer.
// Agents make a PDF on their own when asked for one ("…as a PDF").

export default function FilesBar({ taskId, files: given, canMake, refreshKey }: { taskId: string; files?: CardFile[]; canMake: boolean; refreshKey?: unknown }) {
  const [files, setFiles] = useState<CardFile[]>(given ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (given) return setFiles(given);
    let live = true;
    getJson<{ files?: CardFile[] }>(`/api/tasks/${taskId}`)
      .then((d) => live && setFiles(d.files ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [taskId, given, refreshKey]);

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await send<{ name: string; url: string }>("POST", `/api/tasks/${taskId}/pdf`, {});
      const d = await getJson<{ files?: CardFile[] }>(`/api/tasks/${taskId}`);
      setFiles(d.files ?? []);
      window.open(fileUrl(out.name), "_blank", "noopener");
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1"));
    } finally {
      setBusy(false);
    }
  };

  if (!files.length && !canMake) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {files.map((f) => (
        <span key={f.name} className="flex items-center gap-1.5 bg-slate-950 border border-slate-700 rounded px-2 py-1">
          <span>📄</span>
          <a href={fileUrl(f.name)} target="_blank" rel="noopener" className="text-cyan-300 hover:underline max-w-[220px] truncate" title={f.name}>
            {f.name}
          </a>
          <span className="text-slate-500">
            {Math.max(1, Math.round(f.bytes / 1024))} KB{f.pictures ? ` · ${f.pictures} pic${f.pictures > 1 ? "s" : ""}` : ""}
          </span>
          <a href={fileUrl(f.name, true)} className="text-slate-400 hover:text-cyan-300" title="Download">
            ⬇
          </a>
        </span>
      ))}
      {canMake && (
        <button type="button" onClick={() => void make()} disabled={busy} className="text-slate-400 hover:text-cyan-300 disabled:opacity-50">
          {busy ? "Making PDF…" : files.length ? "📄 New PDF" : "📄 Save as PDF"}
        </button>
      )}
      {error && <span className="text-rose-300">{error}</span>}
    </div>
  );
}
