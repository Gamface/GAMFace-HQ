import { useEffect, useState } from "react";
import { fileUrl, getJson, send } from "../api";
import type { CardFile } from "../api";

// A card's files: PDF reports and rendered videos. Buttons make a PDF from the
// answer, or render (again) the Remotion scene in it. Agents make both on their own
// when asked ("…as a PDF", "make a video…").

const isVideo = (name: string) => name.endsWith(".mp4");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");

export default function FilesBar({
  taskId,
  files: given,
  canMake,
  refreshKey,
}: {
  taskId: string;
  files?: CardFile[];
  canMake: boolean;
  refreshKey?: unknown;
}) {
  const [files, setFiles] = useState<CardFile[]>(given ?? []);
  const [hasScene, setHasScene] = useState(false);
  const [busy, setBusy] = useState<"pdf" | "video" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getJson<{ files?: CardFile[]; answer?: string }>(`/api/tasks/${taskId}`)
      .then((d) => {
        if (!live) return;
        if (!given) setFiles(d.files ?? []);
        setHasScene(/from\s+["']remotion["']/.test(d.answer ?? ""));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [taskId, refreshKey]);
  useEffect(() => {
    if (given) setFiles(given);
  }, [given]);

  const reload = async () => setFiles((await getJson<{ files?: CardFile[] }>(`/api/tasks/${taskId}`)).files ?? []);

  const makePdf = async () => {
    setBusy("pdf");
    setError(null);
    try {
      const out = await send<{ name: string }>("POST", `/api/tasks/${taskId}/pdf`, {});
      await reload();
      window.open(fileUrl(out.name), "_blank", "noopener");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const renderVideo = async () => {
    setBusy("video");
    setError(null);
    try {
      const out = await send<{ files: CardFile[] }>("POST", `/api/tasks/${taskId}/video`, {});
      setFiles(out.files);
      const newest = [...out.files].filter((f) => isVideo(f.name)).sort((a, b) => b.at - a.at)[0];
      if (newest) setPlaying(newest.name);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (!files.length && !canMake) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {files.map((f) => (
          <span key={f.name} className="flex items-center gap-1.5 bg-slate-950 border border-slate-700 rounded px-2 py-1">
            <span>{isVideo(f.name) ? "🎬" : "📄"}</span>
            {isVideo(f.name) ? (
              <button onClick={() => setPlaying(playing === f.name ? null : f.name)} className="text-cyan-300 hover:underline max-w-[220px] truncate" title={f.name}>
                {f.name}
              </button>
            ) : (
              <a href={fileUrl(f.name)} target="_blank" rel="noopener" className="text-cyan-300 hover:underline max-w-[220px] truncate" title={f.name}>
                {f.name}
              </a>
            )}
            <span className="text-slate-500">
              {f.bytes > 1024 * 1024 ? `${(f.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(f.bytes / 1024))} KB`}
              {f.pictures ? ` · ${f.pictures} pic${f.pictures > 1 ? "s" : ""}` : ""}
            </span>
            <a href={fileUrl(f.name, true)} className="text-slate-400 hover:text-cyan-300" title="Download">
              ⬇
            </a>
          </span>
        ))}
        {canMake && (
          <button type="button" onClick={() => void makePdf()} disabled={busy !== null} className="text-slate-400 hover:text-cyan-300 disabled:opacity-50">
            {busy === "pdf" ? "Making PDF…" : files.some((f) => !isVideo(f.name)) ? "📄 New PDF" : "📄 Save as PDF"}
          </button>
        )}
        {canMake && hasScene && (
          <button type="button" onClick={() => void renderVideo()} disabled={busy !== null} className="text-slate-400 hover:text-cyan-300 disabled:opacity-50" title="Render the Remotion scene in this answer">
            {busy === "video" ? "Rendering video… (this can take a few minutes)" : files.some((f) => isVideo(f.name)) ? "🎬 Render again" : "🎬 Render video"}
          </button>
        )}
        {error && <span className="text-rose-300 whitespace-pre-wrap">{error}</span>}
      </div>
      {playing && <video key={playing} src={fileUrl(playing)} controls autoPlay className="w-full max-h-[420px] rounded border border-slate-700 bg-black" />}
    </div>
  );
}
