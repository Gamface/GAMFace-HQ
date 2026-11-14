import { useState } from "react";
import { imageUrl, uploadImage } from "../api";

// Attach pictures by picking, dropping or pasting them. Pictures stay on your PC:
// only the Vision agent sees them, and never a cloud model unless you allow it.

export const MAX_IMAGES = 6;

/** Picture files from a paste or drop event. */
export function imageFiles(list: DataTransferItemList | FileList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (const item of Array.from(list as ArrayLike<DataTransferItem | File>)) {
    const f = item instanceof File ? item : item.kind === "file" ? item.getAsFile() : null;
    if (f && f.type.startsWith("image/")) files.push(f);
  }
  return files;
}

export function useImageUploads(value: string[], onChange: (ids: string[]) => void) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const add = async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_IMAGES - value.length;
    if (room <= 0) return setError(`At most ${MAX_IMAGES} pictures per card`);
    setError(null);
    setBusy((n) => n + 1);
    try {
      const ids: string[] = [];
      for (const f of files.slice(0, room)) ids.push(await uploadImage(f));
      onChange([...new Set([...value, ...ids])]);
      if (files.length > room) setError(`Only the first ${room} picture(s) were added (max ${MAX_IMAGES})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((n) => n - 1);
    }
  };
  return { add, busy: busy > 0, error };
}

export default function ImageAttach({
  value,
  onChange,
  uploader,
  compact,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  uploader: ReturnType<typeof useImageUploads>;
  compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (imageFiles(e.dataTransfer?.items).length || e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const files = imageFiles(e.dataTransfer?.files);
        if (!files.length) return;
        e.preventDefault();
        setOver(false);
        void uploader.add(files);
      }}
      className={`rounded-md border border-dashed ${over ? "border-cyan-500 bg-cyan-950/30" : "border-slate-700"} ${compact ? "p-1.5" : "p-2"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {value.map((id) => (
          <div key={id} className="relative group">
            <a href={imageUrl(id)} target="_blank" rel="noreferrer">
              <img src={imageUrl(id)} alt="attached picture" className={`${compact ? "h-10 w-10" : "h-16 w-16"} object-cover rounded border border-slate-700`} />
            </a>
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x !== id))}
              className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-slate-900 border border-slate-600 text-[9px] leading-none text-slate-300 hover:text-rose-300"
              title="Remove picture"
            >
              ✕
            </button>
          </div>
        ))}
        {value.length < MAX_IMAGES && (
          <label className={`cursor-pointer text-slate-400 hover:text-cyan-300 ${compact ? "text-[11px]" : "text-xs"}`}>
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                void uploader.add(imageFiles(e.target.files));
                e.target.value = "";
              }}
            />
            🖼 {value.length ? "Add" : compact ? "Attach pictures" : "Attach pictures: pick, drop or paste"}
          </label>
        )}
        {uploader.busy && <span className="text-[11px] text-slate-500">uploading…</span>}
      </div>
      {uploader.error && <p className="text-[11px] text-rose-300 mt-1">{uploader.error}</p>}
      {value.length > 0 && !compact && (
        <p className="text-[10px] text-slate-500 mt-1">Only the Vision agent sees pictures; they stay on your PC unless you allow it on the Team page.</p>
      )}
    </div>
  );
}
