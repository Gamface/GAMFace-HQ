import { useCallback, useEffect, useMemo, useState } from "react";
import { fileUrl, getJson, send } from "../api";
import { HARNESS_URL } from "../config";
import { errText, input, primary, quiet } from "./BookParts";
import type { Book } from "./BookParts";

// Cover colours: the back cover, spine, plain front and title band of the paperback, and
// the ebook cover. Pick from the palette library or the suggestions for this book, use the
// brand kit, take them from the cover picture, or set three colours of your own. Colours
// picked automatically (from the genre, by the Writer, or from the picture) keep following
// the book until you choose or lock them.

type Band = "palette" | "dark" | "none";
type Source = "preset" | "custom" | "brand" | "picture" | "auto" | "writer";
interface Colors {
  bg: string;
  fg: string;
  accent: string;
}
interface NamedPalette extends Colors {
  id: string;
  name: string;
  group: string;
}
interface Library {
  groups: { group: string; label: string; palettes: NamedPalette[] }[];
  bands: Band[];
  brand: { background: string; text: string; accent: string } | null;
  pictures: boolean;
  fonts: { id: string; name: string; title: string; text: string }[];
  layouts: { id: string; label: string }[];
}
interface ColorInfo {
  colors: Colors & { band: Band };
  coverColors: (Colors & { source: Source; palette?: string; locked?: boolean; band?: Band }) | null;
  notes: string[];
  suggestions: NamedPalette[];
  brand: { background: string; text: string; accent: string } | null;
  picture: boolean;
  design: { fonts: string; layout: string; auto: boolean };
  ebookCover: { name: string; url: string; stale?: boolean } | null;
}

const BAND_LABEL: Record<Band, string> = { palette: "Tinted with the colours", dark: "Dark band", none: "No band (shadowed text)" };
const SOURCE_LABEL: Record<Source, string> = {
  auto: "Picked from the genre and brief",
  writer: "Chosen by the Writer",
  picture: "Taken from the cover picture",
  preset: "Your palette",
  custom: "Your own colours",
  brand: "Your brand kit",
};
const TRIM_IN: Record<string, [number, number]> = { "5x8": [5, 8], "5.5x8.5": [5.5, 8.5], "6x9": [6, 9], a5: [5.83, 8.27], "8x10": [8, 10], "8.5x8.5": [8.5, 8.5], "8.5x11": [8.5, 11], letter: [8.5, 11] };

// WCAG contrast, as the server checks it
const lum = (hex: string) =>
  [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
    .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const HEX = /^#[0-9a-fA-F]{6}$/;
const normal = (v: string) => {
  let s = v.trim().toLowerCase();
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${[...s.slice(1)].map((c) => c + c).join("")}`;
  return HEX.test(s) ? s : null;
};

function Swatch({ p, active, onPick, title }: { p: Colors & { name?: string }; active?: boolean; onPick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={title ?? p.name}
      className={`group relative w-14 h-20 rounded-sm overflow-hidden border shrink-0 text-left transition ${active ? "border-cyan-400 ring-2 ring-cyan-500/60" : "border-slate-700 hover:border-slate-400"}`}
      style={{ background: p.bg }}
    >
      <span className="absolute left-0 top-0 bottom-0 w-2" style={{ background: p.accent }} />
      <span className="absolute left-3.5 right-1 top-3 h-0.5" style={{ background: p.accent }} />
      <span className="absolute left-3.5 top-5 text-[13px] font-serif leading-none" style={{ color: p.fg }}>
        Aa
      </span>
      <span className="absolute left-3.5 right-1 bottom-2 h-1 rounded-sm opacity-80" style={{ background: p.fg }} />
    </button>
  );
}

function Ratio({ label, value, need }: { label: string; value: number; need: number }) {
  const ok = value >= need;
  return (
    <span className={`text-[11px] ${ok ? "text-emerald-400" : "text-amber-300"}`} title={`Needs ${need}:1 to read well in print`}>
      {label} {value.toFixed(1)}:1 {ok ? "✓" : "⚠ low"}
    </span>
  );
}

export default function CoverColors({ book, onChange, busy }: { book: Book; onChange: (b: Book) => void; busy: boolean }) {
  const [lib, setLib] = useState<Library | null>(null);
  const [info, setInfo] = useState<ColorInfo | null>(null);
  const [draft, setDraft] = useState<(Colors & { band: Band }) | null>(null);
  const [hex, setHex] = useState<Colors>({ bg: "", fg: "", accent: "" });
  const [group, setGroup] = useState<string>("suggested");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"paperback" | "ebook">("paperback");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ebook, setEbook] = useState<{ url: string; name: string } | null>(null);
  const [open, setOpen] = useState(true);

  const loadInfo = useCallback(() => {
    getJson<ColorInfo>(`/api/books/${book.id}/colors`)
      .then((i) => {
        setInfo(i);
        setEbook(i.ebookCover);
      })
      .catch((e) => setError(errText(e)));
  }, [book.id]);
  useEffect(() => {
    getJson<Library>(`/api/books/palettes${book.project ? `?project=${encodeURIComponent(book.project)}` : ""}`)
      .then(setLib)
      .catch((e) => setError(errText(e)));
  }, [book.project]);
  // Reload when the book's colours change (the Writer, the picture, another tab)
  const key = JSON.stringify(book.coverColors ?? null) + (book.cover ?? "") + book.genre + book.title;
  useEffect(() => {
    setDraft(null);
    loadInfo();
  }, [loadInfo, key]);

  const shown = draft ?? info?.colors ?? null;
  useEffect(() => {
    if (shown) setHex({ bg: shown.bg, fg: shown.fg, accent: shown.accent });
  }, [shown?.bg, shown?.fg, shown?.accent]);

  const apply = async (label: string, body: Record<string, unknown>, path = "colors", method: "PUT" | "POST" = "PUT") => {
    setWorking(label);
    setError(null);
    try {
      const out = await send<Book>(method, `/api/books/${book.id}/${path}`, body);
      setDraft(null);
      onChange(out);
    } catch (e) {
      setError(errText(e));
    } finally {
      setWorking(null);
    }
  };

  const makeEbook = async () => {
    setWorking("ebook");
    setError(null);
    try {
      const out = await send<{ name: string; url: string; book: Book }>("POST", `/api/books/${book.id}/ebook-cover`);
      setEbook({ name: out.name, url: out.url });
      onChange(out.book);
    } catch (e) {
      setError(errText(e));
    } finally {
      setWorking(null);
    }
  };

  const all = useMemo(() => lib?.groups.flatMap((g) => g.palettes) ?? [], [lib]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return all.filter((p) => `${p.name} ${p.group} ${p.id}`.toLowerCase().includes(q));
    if (group === "suggested") return info?.suggestions ?? [];
    if (group === "all") return all;
    return lib?.groups.find((g) => g.group === group)?.palettes ?? [];
  }, [all, group, query, lib, info]);

  if (!shown || !lib || !info) return <section className="rounded border border-slate-800 p-3 text-xs text-slate-500">{error ?? "Loading cover colours…"}</section>;

  const cc = info.coverColors;
  const locked = Boolean(cc?.locked);
  const activeId = draft ? null : cc?.palette;
  const [tw, th] = TRIM_IN[book.trim ?? (book.kind === "picture" ? "8.5x8.5" : book.kind === "puzzle" ? "8.5x11" : "6x9")] ?? [6, 9];
  const words = book.chapters.reduce((n, c) => n + (c.words ?? 0), 0) || book.chapterCount * book.chapterWords;
  const pages = book.kind === "picture" ? Math.max(24, book.chapterCount + 4) : Math.max(24, Math.min(828, Math.round(words / 300) + 8));
  const spine = Math.max(pages, 24) * (book.kind === "picture" ? 0.002347 : 0.002252);
  const [pw, ph] = view === "ebook" ? [1600, 2560] : [(2 * tw + spine + 0.25) * 96, (th + 0.25) * 96];
  const boxW = 520;
  const scale = Math.min(boxW / pw, 340 / ph);
  const q = new URLSearchParams({ bg: shown.bg, fg: shown.fg, accent: shown.accent, band: shown.band, ...(view === "ebook" ? { kind: "ebook" } : {}), v: String(book.updatedAt) });
  const previewUrl = `${HARNESS_URL}/api/books/${book.id}/cover-preview?${q}`;
  const setColor = (k: keyof Colors, v: string) => {
    setHex((h) => ({ ...h, [k]: v }));
    const n = normal(v);
    if (n) setDraft({ ...shown, [k]: n });
  };
  const disabled = Boolean(working) || busy;
  const textRatio = contrast(shown.fg, shown.bg);
  const accentRatio = contrast(shown.accent, shown.bg);
  const random = () => {
    const pool = all.filter((p) => p.id !== cc?.palette);
    const p = pool[Math.floor(Math.random() * pool.length)];
    if (p) void apply("random", { colors: p.id });
  };

  return (
    <section className="rounded border border-slate-800 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen(!open)} className="text-sm font-medium text-slate-200 hover:text-white">
          {open ? "▾" : "▸"} Cover colours
        </button>
        <span className="flex gap-0.5" aria-hidden>
          {[shown.bg, shown.accent, shown.fg].map((c, i) => (
            <span key={i} className="w-3 h-3 rounded-sm border border-slate-700" style={{ background: c }} />
          ))}
        </span>
        <span className="text-[11px] text-slate-500 truncate">
          {draft ? "Unsaved changes" : cc ? `${SOURCE_LABEL[cc.source]}${cc.palette ? `: ${all.find((p) => p.id === cc.palette)?.name ?? cc.palette}` : ""}` : "From the title (the default)"}
          {locked && " · locked"}
        </span>
      </div>

      {open && (
        <>
          <div className="flex flex-wrap gap-3 items-start">
            <div className="space-y-1.5">
              <div className="flex gap-1">
                {(["paperback", "ebook"] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setView(v)} className={`text-[11px] px-2 py-0.5 rounded border ${view === v ? "border-cyan-600 text-cyan-300" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>
                    {v === "paperback" ? "Paperback (back · spine · front)" : "Ebook cover"}
                  </button>
                ))}
              </div>
              <div className="rounded border border-slate-800 bg-slate-950 overflow-hidden" style={{ width: pw * scale, height: ph * scale }}>
                <iframe
                  key={previewUrl}
                  src={previewUrl}
                  title="Cover preview"
                  sandbox=""
                  scrolling="no"
                  style={{ width: pw, height: ph, transform: `scale(${scale})`, transformOrigin: "0 0", border: 0, pointerEvents: "none" }}
                />
              </div>
              <p className="text-[10px] text-slate-600">Preview at about {pages} pages; the KDP files are sized to the real page count.</p>
            </div>

            <div className="flex-1 min-w-[220px] space-y-2">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
                {(
                  [
                    ["bg", "Background", "back cover, plain front, spine text"],
                    ["accent", "Accent", "spine, headings, rules"],
                    ["fg", "Text", "blurb and title"],
                  ] as const
                ).map(([k, label, what]) => (
                  <label key={k} className="contents">
                    <input type="color" value={shown[k]} disabled={disabled} onChange={(e) => setColor(k, e.target.value)} className="w-8 h-7 bg-transparent border border-slate-700 rounded cursor-pointer" aria-label={label} />
                    <span className="flex items-center gap-2">
                      <input
                        value={hex[k]}
                        disabled={disabled}
                        onChange={(e) => setColor(k, e.target.value)}
                        className={`${input} !w-24 font-mono !text-xs !py-1 ${normal(hex[k]) ? "" : "!border-rose-700"}`}
                        aria-label={`${label} hex`}
                      />
                      <span className="text-[11px] text-slate-400">
                        {label} <span className="text-slate-600">({what})</span>
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-3">
                <Ratio label="Text" value={textRatio} need={4.5} />
                <Ratio label="Accent" value={accentRatio} need={3} />
              </div>
              {(textRatio < 4.5 || accentRatio < 3) && <p className="text-[11px] text-amber-300">Low contrast is fixed when the cover prints (the text or accent is made lighter or darker), so it may look a little different.</p>}
              {info.notes.map((n) => (
                <p key={n} className="text-[11px] text-amber-300">
                  {n}
                </p>
              ))}
              <label className="flex items-center gap-2 text-[11px] text-slate-400">
                Title band on a cover picture
                <select
                  value={shown.band}
                  disabled={disabled}
                  onChange={(e) => (draft ? setDraft({ ...draft, band: e.target.value as Band }) : void apply("band", { band: e.target.value }))}
                  className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200"
                >
                  {lib.bands.map((b) => (
                    <option key={b} value={b}>
                      {BAND_LABEL[b]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-[11px] text-slate-400">
                Fonts
                <select
                  value={info.design.auto ? "auto" : info.design.fonts}
                  disabled={disabled}
                  onChange={(e) => void apply("fonts", { fonts: e.target.value }, "design")}
                  className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200"
                >
                  <option value="auto">For the genre ({lib.fonts.find((f) => f.id === info.design.fonts)?.name ?? info.design.fonts})</option>
                  {lib.fonts.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} — {f.title}
                      {f.text !== f.title ? ` + ${f.text}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-[11px] text-slate-400">
                Layout over a picture
                <select value={info.design.layout} disabled={disabled} onChange={(e) => void apply("layout", { layout: e.target.value }, "design")} className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 max-w-[14rem]">
                  {lib.layouts.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" disabled={disabled || !draft} onClick={() => draft && void apply("save", { colors: { bg: draft.bg, fg: draft.fg, accent: draft.accent }, band: draft.band })} className={primary}>
                  {working === "save" ? "Saving…" : "Save colours"}
                </button>
                {draft && (
                  <button type="button" onClick={() => setDraft(null)} className={quiet}>
                    Undo
                  </button>
                )}
                <button type="button" disabled={disabled} onClick={() => setDraft({ ...shown, bg: shown.fg, fg: shown.bg })} className={quiet} title="Swap background and text: light cover ⇄ dark cover">
                  ⇄ Invert
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 items-center border-t border-slate-800 pt-2">
            <span className="text-[11px] text-slate-500 mr-1">Automatic:</span>
            <button type="button" disabled={disabled} onClick={() => void apply("auto", { colors: "auto" })} className={quiet} title="Colours that suit the genre, brief and audience; they follow the book as it changes">
              {working === "auto" ? "Picking…" : "From the genre"}
            </button>
            <button
              type="button"
              disabled={disabled || !info.picture || !lib.pictures}
              onClick={() => void apply("picture", {}, "colors/picture", "POST")}
              className={quiet}
              title={!lib.pictures ? "Needs the browser sidecar (BROWSER_CDP_URL)" : !info.picture ? "Add a cover picture first" : "Background and accent taken from the cover picture, so the back and spine match it"}
            >
              {working === "picture" ? "Reading the picture…" : "Match the cover picture"}
            </button>
            {info.brand && (
              <button type="button" disabled={disabled} onClick={() => void apply("brand", { colors: "brand" })} className={quiet} title="Your brand kit's background, text and accent">
                <span className="inline-flex gap-0.5 mr-1 align-middle">
                  {[info.brand.background, info.brand.accent, info.brand.text].map((c, i) => (
                    <span key={i} className="w-2 h-2 rounded-sm" style={{ background: c }} />
                  ))}
                </span>
                Brand kit
              </button>
            )}
            <button type="button" disabled={disabled} onClick={random} className={quiet} title="Any palette from the library">
              🎲 Surprise me
            </button>
            <button type="button" disabled={disabled || !cc} onClick={() => void apply("clear", { colors: null })} className={quiet} title="The palette picked from the title, as books had before">
              Title default
            </button>
            <span className="flex-1" />
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400" title="Locked colours stay as they are: the genre, the Writer and a new cover picture won't change them">
              <input type="checkbox" checked={locked} disabled={disabled || !cc} onChange={(e) => void apply("lock", { locked: e.target.checked })} />
              Lock
            </label>
          </div>
          {cc && !locked && (cc.source === "auto" || cc.source === "writer" || cc.source === "picture") && (
            <p className="text-[11px] text-slate-500">
              These follow the book: they update when the genre or brief changes, when the Writer makes the listing kit, and when you add a cover picture (or make KDP files with one). Choose a palette, set your own or lock them to keep them.
            </p>
          )}

          <div className="space-y-2 border-t border-slate-800 pt-2">
            <div className="flex flex-wrap gap-1 items-center">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${all.length} palettes…`} className={`${input} !w-44 !text-xs !py-1`} />
              {[{ group: "suggested", label: "Suggested" }, ...lib.groups.map((g) => ({ group: g.group, label: g.label })), { group: "all", label: "All" }].map((g) => (
                <button
                  key={g.group}
                  type="button"
                  onClick={() => {
                    setGroup(g.group);
                    setQuery("");
                  }}
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${group === g.group && !query ? "border-cyan-600 text-cyan-300 bg-cyan-950/40" : "border-slate-800 text-slate-400 hover:text-slate-200"}`}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 max-h-72 overflow-y-auto pr-1">
              {list.map((p) => (
                <div key={p.id} className="flex flex-col items-center gap-0.5 w-16">
                  <Swatch p={p} active={activeId === p.id} onPick={() => !disabled && void apply(p.id, { colors: p.id })} title={`${p.name} — ${p.bg} / ${p.accent} / ${p.fg}`} />
                  <span className="text-[10px] text-slate-500 text-center leading-tight line-clamp-2">{p.name}</span>
                </div>
              ))}
              {!list.length && <p className="text-xs text-slate-500">No palettes match “{query}”.</p>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2">
            <button type="button" disabled={disabled || !lib.pictures} onClick={() => void makeEbook()} className={quiet} title={lib.pictures ? "A 1600 × 2560 JPEG in these colours, for KDP and ebook stores" : "Needs the browser sidecar (BROWSER_CDP_URL)"}>
              {working === "ebook" ? "Drawing the ebook cover…" : ebook ? "Make the ebook cover again" : "Make the ebook cover (1600 × 2560)"}
            </button>
            {ebook && (
              <>
                <a href={fileUrl(ebook.name, true)} className="text-xs text-cyan-400 hover:text-cyan-300">
                  Download ebook cover
                </a>
                <img src={fileUrl(ebook.name)} alt="Ebook cover" className="h-16 rounded-sm border border-slate-700" />
                {!book.cover && <span className="text-[11px] text-slate-500">Also used as the EPUB's cover.</span>}
                {info.ebookCover?.stale && <span className="text-[11px] text-amber-300">The colours or title changed since it was made: make it again.</span>}
              </>
            )}
          </div>
          {error && <p className="text-xs text-rose-300">{error}</p>}
        </>
      )}
    </section>
  );
}
