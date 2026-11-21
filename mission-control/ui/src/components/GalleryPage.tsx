import { useEffect, useState } from "react";
import { fileUrl, getJson, send } from "../api";
import { useProjects } from "../project";

// The Gallery: every picture and clip the cards made (the picture tool, Inspo screenshots,
// rendered videos), newest first. A good one goes into the asset dictionary with one
// click, so the Coder can use it in videos.

type Kind = "image" | "video";
interface Item {
  name: string;
  kind: Kind;
  bytes: number;
  at: number;
  card?: { id: string; title: string; project?: string | null };
  asset?: string;
  suggestedName: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");
const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function AddToAssets({ item, onDone, onCancel }: { item: Item; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(item.suggestedName);
  const [description, setDescription] = useState(item.card ? item.card.title : "");
  const [role, setRole] = useState(item.kind === "video" ? "broll" : "picture");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await send("POST", `/api/gallery/${encodeURIComponent(item.name)}/asset`, {
        name: name.trim() || item.suggestedName,
        description: description.trim(),
        tags: [],
        role,
        project: item.card?.project ?? null,
      });
      onDone();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 pt-2 border-t border-slate-800">
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Name" className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={400}
        rows={2}
        placeholder="Describe it, so the Coder picks it for the right video"
        className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
      />
      <div className="flex items-center gap-2 text-xs">
        {item.kind === "image" ? (
          <select value={role} onChange={(e) => setRole(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200">
            <option value="picture">Picture</option>
            <option value="logo">Logo</option>
          </select>
        ) : (
          <span className="text-slate-400">B-roll clip</span>
        )}
        <span className="flex-1" />
        <button onClick={onCancel} className="px-2 py-1 rounded text-slate-400 hover:text-slate-200">
          Cancel
        </button>
        <button disabled={busy} onClick={() => void save()} className="px-3 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium disabled:opacity-50">
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-300">{error}</p>}
    </div>
  );
}

function Tile({ item, onChange }: { item: Item; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const src = fileUrl(item.name);
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
      <a href={src} target="_blank" rel="noreferrer" className="block bg-slate-950 aspect-video">
        {item.kind === "image" ? (
          <img src={src} alt={item.suggestedName} loading="lazy" className="w-full h-full object-contain" />
        ) : (
          <video src={src} controls preload="metadata" className="w-full h-full object-contain" onClick={(e) => e.preventDefault()} />
        )}
      </a>
      <div className="p-3 space-y-1.5 text-xs flex-1 flex flex-col">
        <p className="text-slate-200 line-clamp-2" title={item.card?.title}>
          {item.card ? item.card.title : <span className="text-slate-500 italic">Card no longer on the board</span>}
        </p>
        <p className="text-slate-500">
          {item.kind === "video" ? "🎬 Clip" : "🖼 Picture"} · {size(item.bytes)} · {when(item.at)}
        </p>
        <div className="flex items-center gap-2 pt-1 mt-auto">
          <a href={fileUrl(item.name, true)} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200">
            Download
          </a>
          <span className="flex-1" />
          {item.asset ? (
            <a href="#assets" className="text-emerald-400 hover:text-emerald-300" title="It's in the asset dictionary">
              ✓ In Assets
            </a>
          ) : (
            !adding && (
              <button onClick={() => setAdding(true)} className="px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 text-white">
                ＋ Add to Assets
              </button>
            )
          )}
        </div>
        {adding && (
          <AddToAssets
            item={item}
            onCancel={() => setAdding(false)}
            onDone={() => {
              setAdding(false);
              onChange();
            }}
          />
        )}
      </div>
    </div>
  );
}

export default function GalleryPage() {
  const proj = useProjects();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [onlyNew, setOnlyNew] = useState(false);
  const load = () =>
    getJson<{ items: Item[] }>(`/api/gallery${proj.query ? `?${proj.query}` : ""}`)
      .then((d) => setItems(d.items))
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj.view]);

  if (!items) return <div className="col-span-3 p-6 text-slate-500">{error ?? "Loading the gallery…"}</div>;
  const shown = items.filter((i) => (filter === "all" || i.kind === filter) && (!onlyNew || !i.asset));
  const count = (k: Kind) => items.filter((i) => i.kind === k).length;

  return (
    <div className="col-span-3 min-h-0 overflow-y-auto space-y-4 pr-1">
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-200">Gallery</h2>
          <p className="text-xs text-slate-500 flex-1 min-w-[260px]">
            Everything the cards made: pictures from the picture tool, design references and rendered videos. Add the good ones to Assets so the Coder can use them in videos.
          </p>
          <button onClick={() => void load()} className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs">
            Refresh
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {(
            [
              ["all", `All ${items.length}`],
              ["image", `Pictures ${count("image")}`],
              ["video", `Clips ${count("video")}`],
            ] as ["all" | Kind, string][]
          ).map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)} className={`px-3 py-1 rounded-md ${filter === k ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"}`}>
              {label}
            </button>
          ))}
          <label className="ml-3 flex items-center gap-1.5 text-slate-300">
            <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
            Not in Assets yet
          </label>
        </div>
        {error && <p className="text-xs text-rose-300">{error}</p>}
        {shown.length === 0 ? (
          <div className="border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">
            {items.length === 0 ? 'Nothing yet. Ask HQ to "make a picture of…" or "find design inspiration for…", and the results show up here.' : "Nothing matches this filter."}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
            {shown.map((i) => (
              <Tile key={i.name} item={i} onChange={load} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
