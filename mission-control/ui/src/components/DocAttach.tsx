import { useEffect, useState } from "react";
import { getJson, uploadPdf, uploadUrl } from "../api";
import type { DocInfo } from "../api";

// Attach PDFs: pick or drop them. The harness reads the text on your PC; short
// documents go to the agent whole, long ones are read in parts by Jarvis File.

export const MAX_DOCS = 4;
const MAX_MB = 25;

export function pdfFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
}

export function useDocUploads(value: string[], onChange: (ids: string[]) => void) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<Record<string, DocInfo>>({});
  // Cards opened for editing know only ids: look their names up
  useEffect(() => {
    for (const id of value)
      if (!info[id])
        getJson<DocInfo>(`/api/uploads/${id}/info`)
          .then((d) => setInfo((m) => ({ ...m, [id]: d })))
          .catch(() => {});
  }, [value, info]);
  const add = async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_DOCS - value.length;
    if (room <= 0) return setError(`At most ${MAX_DOCS} PDFs per card`);
    const tooBig = files.find((f) => f.size > MAX_MB * 1024 * 1024);
    if (tooBig) return setError(`${tooBig.name} is over ${MAX_MB} MB`);
    setError(null);
    setBusy((n) => n + 1);
    try {
      const ids: string[] = [];
      for (const f of files.slice(0, room)) {
        const d = await uploadPdf(f);
        ids.push(d.id);
        setInfo((m) => ({ ...m, [d.id]: d }));
      }
      onChange([...new Set([...value, ...ids])]);
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1"));
    } finally {
      setBusy((n) => n - 1);
    }
  };
  return { add, busy: busy > 0, error, info };
}

export function DocChip({ id, info, onRemove }: { id: string; info?: DocInfo; onRemove?: () => void }) {
  return (
    <span className="flex items-center gap-1.5 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px]">
      <span>📑</span>
      <a href={uploadUrl(id)} target="_blank" rel="noopener" className="text-cyan-300 hover:underline max-w-[200px] truncate" title={info?.name}>
        {info?.name ?? "PDF"}
      </a>
      {info && (
        <span className="text-slate-500">
          {info.pages} page{info.pages === 1 ? "" : "s"}
        </span>
      )}
      {info?.scanned && (
        <span className="text-amber-300" title="Little or no text: it may be scanned. Attach page screenshots as pictures so Vision can read them.">
          ⚠ scanned?
        </span>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} className="text-[10px] text-slate-500 hover:text-rose-300" title="Remove PDF">
          ✕
        </button>
      )}
    </span>
  );
}

export default function DocAttach({
  value,
  onChange,
  uploader,
  compact,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  uploader: ReturnType<typeof useDocUploads>;
  compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const files = pdfFiles(e.dataTransfer?.files);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        void uploader.add(files);
      }}
      className={`rounded-md border border-dashed ${over ? "border-cyan-500 bg-cyan-950/30" : "border-slate-700"} ${compact ? "p-1.5" : "p-2"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {value.map((id) => (
          <DocChip key={id} id={id} info={uploader.info[id]} onRemove={() => onChange(value.filter((x) => x !== id))} />
        ))}
        {value.length < MAX_DOCS && (
          <label className={`cursor-pointer text-slate-400 hover:text-cyan-300 ${compact ? "text-[11px]" : "text-xs"}`}>
            <input
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                void uploader.add(pdfFiles(e.target.files));
                e.target.value = "";
              }}
            />
            📑 {value.length ? "Add PDF" : compact ? "Attach PDF" : "Attach PDF: pick or drop a file"}
          </label>
        )}
        {uploader.busy && <span className="text-[11px] text-slate-500">reading PDF…</span>}
      </div>
      {uploader.error && <p className="text-[11px] text-rose-300 mt-1">{uploader.error}</p>}
      {value.length > 0 && !compact && (
        <p className="text-[10px] text-slate-500 mt-1">Read on your PC. Long PDFs are read in parts by Jarvis File; the contents never go to a cloud model unless you allow it.</p>
      )}
    </div>
  );
}
