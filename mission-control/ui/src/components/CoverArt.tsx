import { useEffect, useState } from "react";
import { fileUrl, getJson, send } from "../api";
import { HARNESS_URL } from "../config";
import { errText, input, primary, quiet } from "./BookParts";
import type { Book } from "./BookParts";

// AI cover art: the Writer writes an art brief from the book in the style you choose, and the
// picture tool (ComfyUI on your graphics card) draws a few options in the background, about a
// minute and a half each. Pick one to make it the cover picture: it's scaled to 300 dpi for
// the trim, and colours picked automatically follow it. The title and author are set in real
// type by the cover layout, never drawn into the picture.

interface Meta {
  styles: { id: string; name: string }[];
  art: boolean;
  maxOptions: number;
}

export default function CoverArt({ book, onChange }: { book: Book; onChange: (b: Book) => void }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const a = book.coverArt;
  const [style, setStyle] = useState<string>(a?.style ?? "auto");
  const [note, setNote] = useState(a?.note ?? "");
  const [count, setCount] = useState(3);
  const [useColors, setUseColors] = useState(Boolean(a?.useColors));
  const [own, setOwn] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [trying, setTrying] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note2, setNote2] = useState<string | null>(null);
  const [showBrief, setShowBrief] = useState(false);

  useEffect(() => {
    getJson<Meta>("/api/books/palettes")
      .then(setMeta)
      .catch((e) => setError(errText(e)));
  }, []);

  const call = async (label: string, method: "POST" | "DELETE", path: string, body?: unknown) => {
    setWorking(label);
    setError(null);
    try {
      const out = await send<Book & { note?: string }>(method, `/api/books/${book.id}/${path}`, body);
      setNote2(out.note || null);
      onChange(out);
    } catch (e) {
      setError(errText(e));
    } finally {
      setWorking(null);
    }
  };

  if (!meta) return null;
  const drawing = Boolean(a && a.pending > 0 && !a.error);
  const runningHere = book.running && /cover/i.test(book.running.label);
  const options = a?.options ?? [];
  const minutes = Math.round(count * 1.6 + (own ? 0 : 0.3));
  const previewUrl = (name: string) => `${HARNESS_URL}/api/books/${book.id}/cover-preview?kind=ebook&option=${encodeURIComponent(name)}&v=${book.updatedAt}`;

  return (
    <section className="rounded border border-slate-800 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-slate-200">Cover art</h3>
        <span className="text-[11px] text-slate-500">AI pictures for the front, drawn on your graphics card; the title is set in real type on top</span>
      </div>
      {!meta.art ? (
        <p className="text-xs text-slate-500">Cover art needs the picture tool: the tools service with ComfyUI (see README-HQ, Pictures). You can still upload your own cover picture above.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            {meta.styles.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={own}
                onClick={() => setStyle(s.id)}
                className={`text-[11px] px-2 py-0.5 rounded-full border disabled:opacity-40 ${style === s.id ? "border-cyan-600 text-cyan-300 bg-cyan-950/40" : "border-slate-800 text-slate-400 hover:text-slate-200"}`}
              >
                {s.name}
              </button>
            ))}
          </div>
          {own ? (
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Describe the picture: subject, setting, light, colours and style. Leave out the title: it's added in type, and the picture is told to have no text."
              className={`${input} !text-xs`}
            />
          ) : (
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What should it show? (optional: “a lighthouse in a storm”, “just the red door”) — the Writer reads the book either way"
              className={`${input} !text-xs`}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
              Options
              <select value={count} onChange={(e) => setCount(Number(e.target.value))} className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200">
                {Array.from({ length: meta.maxOptions }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400" title="Asks the picture for the book's background and accent colours">
              <input type="checkbox" checked={useColors} disabled={own} onChange={(e) => setUseColors(e.target.checked)} />
              In the cover colours
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <input
                type="checkbox"
                checked={own}
                onChange={(e) => {
                  setOwn(e.target.checked);
                  if (e.target.checked && !prompt && a?.prompt) setPrompt(a.prompt.replace(/\s*Vertical book cover art\..*$/, ""));
                }}
              />
              Write the prompt myself
            </label>
            <span className="flex-1" />
            {drawing ? (
              <button type="button" disabled={Boolean(working)} onClick={() => void call("stop", "POST", "cover-art/stop")} className={quiet}>
                Stop drawing
              </button>
            ) : (
              <button
                type="button"
                disabled={Boolean(working) || (own && prompt.trim().split(/\s+/).length < 4)}
                onClick={() => void call("draw", "POST", "cover-art", { style, note, count, useColors, ...(own ? { prompt } : {}) })}
                className={primary}
              >
                {working === "draw" ? "Asking…" : `Draw ${count} option${count > 1 ? "s" : ""} (~${minutes} min)`}
              </button>
            )}
          </div>

          {drawing && (
            <p className="text-xs text-cyan-300">
              {runningHere ? `${book.running!.label}…` : `Waiting to draw ${a!.pending} option${a!.pending > 1 ? "s" : ""} (after the step that's running now).`}{" "}
              <span className="text-slate-500">You can keep working; the options appear here as they're done.</span>
            </p>
          )}
          {a?.error && <p className="text-xs text-rose-300">The cover art stopped: {a.error}</p>}
          {a?.prompt && (
            <div className="text-[11px] text-slate-500">
              {a.concept && (a.concept.startsWith("Quick brief") ? <span className="text-amber-300">{a.concept}. </span> : <span className="text-slate-300">“{a.concept}” </span>)}
              <button type="button" onClick={() => setShowBrief(!showBrief)} className="text-cyan-500 hover:text-cyan-300">
                {showBrief ? "Hide the brief" : "Show the brief"}
              </button>
              {showBrief && <p className="mt-1 whitespace-pre-wrap text-slate-400">{a.prompt}</p>}
            </div>
          )}

          {options.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {[...options].reverse().map((o) => {
                const picked = a?.picked === o.name;
                return (
                  <div key={o.name} className={`w-32 space-y-1 rounded p-1 ${picked ? "bg-cyan-950/50 ring-1 ring-cyan-600" : ""}`}>
                    <button type="button" onClick={() => setTrying(trying === o.name ? null : o.name)} className="block w-full" title="Try it on the cover">
                      <img src={fileUrl(o.name)} alt="Cover option" className="w-full aspect-[2/3] object-cover rounded-sm border border-slate-700" loading="lazy" />
                    </button>
                    <div className="flex items-center gap-1">
                      <button type="button" disabled={Boolean(working) || picked} onClick={() => void call(`pick:${o.name}`, "POST", "cover-art/pick", { name: o.name })} className={`${picked ? quiet : primary} !px-2 !py-1 flex-1`}>
                        {picked ? "On the cover" : working === `pick:${o.name}` ? "Scaling…" : "Use this"}
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(working)}
                        onClick={() => void call(`del:${o.name}`, "DELETE", `cover-art/options/${encodeURIComponent(o.name)}`)}
                        className="text-slate-500 hover:text-rose-300 text-xs px-1"
                        title="Drop this option"
                        aria-label="Drop this option"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {trying && (
            <div className="flex gap-3 items-start">
              <div className="rounded border border-slate-800 overflow-hidden" style={{ width: 200, height: 320 }}>
                <iframe src={previewUrl(trying)} title="Cover with this picture" sandbox="" scrolling="no" style={{ width: 1600, height: 2560, transform: "scale(0.125)", transformOrigin: "0 0", border: 0, pointerEvents: "none" }} />
              </div>
              <div className="text-[11px] text-slate-500 space-y-1 max-w-xs">
                <p>How this option looks with the title, fonts and layout set below (the ebook cover; the paperback uses the same front).</p>
                <button type="button" onClick={() => setTrying(null)} className="text-cyan-500 hover:text-cyan-300">
                  Close
                </button>
              </div>
            </div>
          )}
          {note2 && <p className="text-[11px] text-emerald-400">{note2}</p>}
          {error && <p className="text-xs text-rose-300">{error}</p>}
          <p className="text-[10px] text-slate-600">KDP asks whether a cover is AI-generated: say yes for pictures made here.</p>
        </>
      )}
    </section>
  );
}
