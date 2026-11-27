import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, send } from "../api";
import { HARNESS_URL } from "../config";

// The Studio's pictures: add pictures (upload, or from the shared Pictures/Downloads folders), then
// put text on them, upscale 4x, repaint parts (draw boxes on the picture), convert, or render an
// SVG design. Every tool makes a new file; originals are never changed.

interface Pic {
  path: string;
  name: string;
  width: number;
  height: number;
  sizeMB: number;
  at: number;
}
type Box = [number, number, number, number];
type Tool = "text" | "upscale" | "edit" | "convert" | "svg";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");
const input = "w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";
const btn = "px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50";
const primary = `${btn} bg-cyan-600 hover:bg-cyan-500 text-white`;
const quiet = `${btn} border border-slate-700 text-slate-300 hover:bg-slate-800`;
const fileUrl = (rel: string, download = false) => `${HARNESS_URL}/api/studio/files/${rel.split("/").map(encodeURIComponent).join("/")}${download ? "?download=1" : ""}`;

/** The picture with boxes drawn on it: drag for a box to repaint, Shift+drag for one to keep. */
function BoxCanvas({ pic, boxes, keep, onBoxes, onKeep, drawing }: { pic: Pic; boxes: Box[]; keep: Box[]; onBoxes: (b: Box[]) => void; onKeep: (b: Box[]) => void; drawing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number; keep: boolean } | null>(null);
  const toPx = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * pic.width), Math.round(((e.clientY - r.top) / r.height) * pic.height)];
  };
  const pct = (b: Box) => ({ left: `${(Math.min(b[0], b[2]) / pic.width) * 100}%`, top: `${(Math.min(b[1], b[3]) / pic.height) * 100}%`, width: `${(Math.abs(b[2] - b[0]) / pic.width) * 100}%`, height: `${(Math.abs(b[3] - b[1]) / pic.height) * 100}%` });
  return (
    <div
      ref={ref}
      className={`relative inline-block max-w-full select-none ${drawing ? "cursor-crosshair" : ""}`}
      onPointerDown={(e) => {
        if (!drawing) return;
        const [x, y] = toPx(e);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDrag({ x0: x, y0: y, x1: x, y1: y, keep: e.shiftKey });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const [x, y] = toPx(e);
        setDrag({ ...drag, x1: Math.max(0, Math.min(pic.width, x)), y1: Math.max(0, Math.min(pic.height, y)) });
      }}
      onPointerUp={() => {
        if (!drag) return;
        const b: Box = [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1)];
        if (b[2] - b[0] > 4 && b[3] - b[1] > 4) (drag.keep ? onKeep([...keep, b]) : onBoxes([...boxes, b]));
        setDrag(null);
      }}
    >
      <img src={fileUrl(pic.path)} alt={pic.name} draggable={false} className="max-h-[60vh] max-w-full rounded border border-slate-800 block" />
      {boxes.map((b, i) => (
        <div key={`b${i}`} style={pct(b)} className="absolute border-2 border-rose-500 bg-rose-500/20 pointer-events-none" />
      ))}
      {keep.map((b, i) => (
        <div key={`k${i}`} style={pct(b)} className="absolute border-2 border-emerald-400 bg-emerald-400/20 pointer-events-none" />
      ))}
      {drag && <div style={pct([drag.x0, drag.y0, drag.x1, drag.y1])} className={`absolute border-2 border-dashed pointer-events-none ${drag.keep ? "border-emerald-400" : "border-rose-500"}`} />}
    </div>
  );
}

export default function PictureStudio({ comfy, upscaleReady, folders, onJob }: { comfy: boolean; upscaleReady: boolean; folders: string[]; onJob: () => void }) {
  const [pics, setPics] = useState<Pic[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("text");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ folder: string; path: string; sizeMB: number }[] | null>(null);
  const [text, setText] = useState({ title: "", subtitle: "", position: "bottom", color: "#ffffff" });
  const [edit, setEdit] = useState({ prompt: "", strength: 0.9 });
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [keep, setKeep] = useState<Box[]>([]);
  const [svg, setSvg] = useState('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">\n  <rect width="1280" height="720" fill="#101820"/>\n  <text x="640" y="380" text-anchor="middle" font-family="Inter" font-size="96" font-weight="800" fill="#f2aa4c">ALL BLACKS</text>\n</svg>');
  const load = useCallback(() => {
    getJson<{ pictures: Pic[] }>("/api/studio/pictures")
      .then((r) => {
        setPics(r.pictures);
        setSel((s) => s ?? r.pictures[0]?.path ?? null);
      })
      .catch((e) => setMsg(errText(e)));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);
  const pic = pics.find((p) => p.path === sel) ?? null;
  useEffect(() => {
    setBoxes([]);
    setKeep([]);
  }, [sel]);

  const run = async (fn: () => Promise<{ file?: string; path?: string } | void>, done?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const out = await fn();
      if (out && (out.file || out.path)) {
        load();
        setSel(out.file ?? out.path ?? null);
      }
      if (done) setMsg(done);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const upload = (files: FileList | null) =>
    void run(async () => {
      let last: { path: string } | undefined;
      for (const file of [...(files ?? [])]) {
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
          r.readAsDataURL(file);
        });
        last = await send<{ path: string }>("POST", "/api/studio/pictures", { filename: file.name, data });
      }
      return last;
    });
  const job = (body: Record<string, unknown>, what: string) =>
    void run(async () => {
      await send("POST", "/api/studio/jobs", body);
      onJob();
    }, `${what}: see Jobs below. The result shows up here when it's done.`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${primary} cursor-pointer`}>
          + Add pictures
          <input type="file" multiple accept="image/*,.svg,.psd,.tif,.tiff,.pdf" className="hidden" onChange={(e) => upload(e.target.files)} />
        </label>
        <button onClick={() => setTool("svg")} className={`${quiet} ${tool === "svg" ? "border-cyan-700 text-cyan-300" : ""}`}>
          New SVG design
        </button>
        {folders.length > 0 && (
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void getJson<{ files: { folder: string; path: string; sizeMB: number }[] }>(`/api/studio/shared?kind=pictures&q=${encodeURIComponent(q)}`).then((r) => setFound(r.files), (e) => setMsg(errText(e)));
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} className={`${input} w-56`} placeholder={`Find in ${folders.join(", ")}`} aria-label="Find pictures in shared folders" />
            <button className={quiet}>Find</button>
          </form>
        )}
      </div>
      {found && (
        <div className="rounded border border-slate-800 p-2 max-h-40 overflow-y-auto">
          {found.length ? (
            found.slice(0, 40).map((f) => (
              <button key={`${f.folder}/${f.path}`} onClick={() => void run(() => send<{ path: string }>("POST", "/api/studio/pictures/import", { path: f.path, folder: f.folder }).then((r) => (setFound(null), r)))} className="block w-full text-left text-[11px] text-slate-300 hover:text-cyan-300 truncate">
                + {f.folder}: {f.path} <span className="text-slate-600">{f.sizeMB} MB</span>
              </button>
            ))
          ) : (
            <p className="text-[11px] text-slate-500">Nothing matches.</p>
          )}
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto pb-1">
        {pics.slice(0, 60).map((p) => (
          <button key={p.path} onClick={() => setSel(p.path)} title={`${p.path} (${p.width}×${p.height})`} className={`shrink-0 rounded border-2 ${sel === p.path ? "border-cyan-500" : "border-transparent hover:border-slate-600"}`}>
            <img src={fileUrl(p.path)} alt={p.name} loading="lazy" className="h-16 w-16 object-cover rounded" />
          </button>
        ))}
        {!pics.length && <p className="text-xs text-slate-500">No pictures yet: add some, or ask Jarvis to make one.</p>}
      </div>

      {pic && (
        <section className="space-y-3">
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="text-slate-200 truncate">{pic.name}</span>
            <span>
              {pic.width}×{pic.height} · {pic.sizeMB} MB
            </span>
            <a href={fileUrl(pic.path, true)} className="text-cyan-400 hover:text-cyan-300 ml-auto">
              Download
            </a>
            <button
              onClick={() => {
                if (!confirm(`Move ${pic.name} to the studio's trash (data/studio/.trash)? It can be put back from there.`)) return;
                void run(async () => {
                  await send("DELETE", `/api/studio/${pic.path.split("/").map(encodeURIComponent).join("/")}`);
                  setSel(null);
                  load();
                });
              }}
              className="text-slate-500 hover:text-rose-300"
            >
              🗑 Trash
            </button>
          </div>
          <BoxCanvas pic={pic} boxes={boxes} keep={keep} onBoxes={setBoxes} onKeep={setKeep} drawing={tool === "edit"} />
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["text", "Text on it"],
                ["upscale", "Upscale 4×"],
                ["edit", "Repaint part"],
                ["convert", "Convert"],
                ["svg", "SVG design"],
              ] as const
            ).map(([t, label]) => (
              <button key={t} onClick={() => setTool(t)} className={`${btn} border ${tool === t ? "border-cyan-600 bg-cyan-950 text-cyan-300" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
                {label}
              </button>
            ))}
          </div>

          {tool === "text" && (
            <div className="grid sm:grid-cols-2 gap-2">
              <input value={text.title} onChange={(e) => setText({ ...text, title: e.target.value })} className={input} placeholder="Title" aria-label="Title" />
              <input value={text.subtitle} onChange={(e) => setText({ ...text, subtitle: e.target.value })} className={input} placeholder="Subtitle or credit (optional)" aria-label="Subtitle" />
              <div className="flex gap-2 items-center">
                <select value={text.position} onChange={(e) => setText({ ...text, position: e.target.value })} className={input} aria-label="Position">
                  {["top", "center", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
                <input type="color" value={text.color} onChange={(e) => setText({ ...text, color: e.target.value })} aria-label="Text colour" className="h-8 w-10 bg-transparent" />
              </div>
              <button disabled={busy || !text.title.trim()} onClick={() => void run(() => send("POST", "/api/studio/pictures/text", { picture: pic.path, ...text }))} className={primary}>
                Put the text on
              </button>
            </div>
          )}
          {tool === "upscale" && (
            <div className="space-y-2 text-xs text-slate-400">
              <p>4× larger and sharper with Real-ESRGAN on the graphics card: {pic.width}×{pic.height} becomes {pic.width * 4}×{pic.height * 4}. For a print cover that's under 300 dpi.</p>
              {!upscaleReady && <p className="text-amber-300">ComfyUI has no upscale model yet: put RealESRGAN_x4plus.pth in ComfyUI's models\upscale_models folder (see README-HQ, Pictures).</p>}
              <button disabled={busy || !comfy || !upscaleReady} onClick={() => job({ type: "upscale", picture: pic.path }, "Upscaling")} className={primary}>
                Upscale 4×
              </button>
            </div>
          )}
          {tool === "edit" && (
            <div className="space-y-2">
              <p className="text-[11px] text-slate-500">
                Drag on the picture to mark what to repaint (red); Shift+drag marks parts inside it to keep (green). Only the red boxes change.{" "}
                {(boxes.length > 0 || keep.length > 0) && (
                  <button
                    onClick={() => {
                      setBoxes([]);
                      setKeep([]);
                    }}
                    className="text-cyan-400"
                  >
                    Clear boxes
                  </button>
                )}
              </p>
              <input value={edit.prompt} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} className={input} placeholder="What the red boxes should show instead, e.g. clear evening sky" aria-label="What to paint" />
              <label className="block text-xs text-slate-400">
                How freely to repaint: {Math.round(edit.strength * 100)}%
                <input type="range" min={0.5} max={1} step={0.05} value={edit.strength} onChange={(e) => setEdit({ ...edit, strength: Number(e.target.value) })} className="w-full" />
              </label>
              <button disabled={busy || !comfy || !boxes.length || !edit.prompt.trim()} onClick={() => job({ type: "edit", picture: pic.path, prompt: edit.prompt, boxes, keep, strength: edit.strength }, "Repainting")} className={primary}>
                Repaint {boxes.length || ""} {boxes.length === 1 ? "box" : "boxes"}
              </button>
            </div>
          )}
          {tool === "convert" && (
            <div className="flex flex-wrap gap-1.5">
              {["png", "jpg", "webp", "tiff", "pdf"].map((f) => (
                <button key={f} disabled={busy} onClick={() => void run(() => send<{ file: string }>("POST", "/api/studio/pictures/convert", { picture: pic.path, to: f }).then((r) => (f === "pdf" ? (window.open(fileUrl(r.file, true)), undefined) : r)))} className={quiet}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {tool === "svg" && (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-500">Write or paste an SVG (title cards, posters, cover layouts). It must be self-contained: no links to files or the web. Inter is available as a font.</p>
          <textarea value={svg} onChange={(e) => setSvg(e.target.value)} rows={8} className={`${input} font-mono text-xs`} aria-label="SVG" />
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => void run(() => send("POST", "/api/studio/pictures/svg", { svg, title: "design" }))} className={primary}>
              Render PNG
            </button>
            <button disabled={busy} onClick={() => void run(() => send<{ file: string }>("POST", "/api/studio/pictures/svg", { svg, title: "design", format: "pdf" }).then((r) => void window.open(fileUrl(r.file, true))))} className={quiet}>
              Render PDF
            </button>
          </div>
        </div>
      )}
      {!pic && tool !== "svg" && pics.length > 0 && <p className="text-xs text-slate-500">Pick a picture above.</p>}
      {msg && <p className="text-xs text-slate-400">{msg}</p>}
    </div>
  );
}
