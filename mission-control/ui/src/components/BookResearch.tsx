import { useCallback, useEffect, useState } from "react";
import { getJson, send } from "../api";
import { useProjects } from "../project";
import { KIND_LABEL, btn, errText, input, primary, quiet } from "./BookParts";
import type { Kind } from "./BookParts";

// Niche research: Amazon's search suggestions (demand), the first page of results for the
// strongest phrases (competition), and three book ideas from the Writer. Any idea starts a
// new book with its brief filled in.

interface Competition {
  results: number;
  medianReviews: number;
  lowShare: number;
  avgPrice?: number;
  avgRating?: number;
  titles: string[];
  sponsored: number;
}

interface Keyword {
  text: string;
  demand: number;
  letters: number;
  competition?: Competition;
  score?: number;
}

export interface Concept {
  title: string;
  kind: Kind;
  keyword: string;
  angle: string;
  audience: string;
  brief: string;
  why: string;
}

interface Research {
  id: string;
  seed: string;
  market: "books" | "kindle";
  status: "mining" | "competition" | "thinking" | "done" | "failed";
  error?: string;
  notes: string[];
  keywords: Keyword[];
  concepts?: Concept[];
  summary?: string;
  createdAt: number;
  progress: string | null;
}

const running = (r: Research) => r.status !== "done" && r.status !== "failed";

function Bar({ value, tone = "bg-cyan-500" }: { value: number; tone?: string }) {
  return (
    <div className="h-1.5 w-16 rounded bg-slate-800 overflow-hidden" aria-label={`${value} of 100`}>
      <div className={`h-full ${tone}`} style={{ width: `${Math.max(2, value)}%` }} />
    </div>
  );
}

function KeywordTable({ r }: { r: Research }) {
  const [all, setAll] = useState(false);
  const checked = r.keywords.filter((k) => k.competition);
  const rows = [...(checked.length ? [...checked].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) : []), ...r.keywords.filter((k) => !k.competition)];
  const shown = all ? rows : rows.slice(0, 15);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-800">
            <th className="py-1.5 pr-3 font-normal">Search phrase</th>
            <th className="py-1.5 pr-3 font-normal" title="How early and how often Amazon suggests it, relative to the strongest phrase">
              Demand
            </th>
            <th className="py-1.5 pr-3 font-normal" title="Median review count of the first page's organic listings">
              Median reviews
            </th>
            <th className="py-1.5 pr-3 font-normal" title="Share of first-page listings with fewer than 100 reviews">
              Under 100
            </th>
            <th className="py-1.5 pr-3 font-normal">Avg price</th>
            <th className="py-1.5 font-normal" title="Demand against competition, among the phrases checked">
              Opportunity
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((k) => (
            <tr key={k.text} className="border-b border-slate-800/60 align-top">
              <td className="py-1.5 pr-3 text-slate-200">
                {k.text}
                {k.competition && k.competition.titles.length > 0 && (
                  <p className="text-[10px] text-slate-500 truncate max-w-xs" title={k.competition.titles.join("\n")}>
                    vs. {k.competition.titles.slice(0, 2).join(" · ")}
                  </p>
                )}
              </td>
              <td className="py-1.5 pr-3">
                <div className="flex items-center gap-1.5">
                  <Bar value={k.demand} />
                  <span className="text-slate-400">{k.demand}</span>
                </div>
              </td>
              <td className="py-1.5 pr-3 text-slate-300">{k.competition ? k.competition.medianReviews.toLocaleString() : "—"}</td>
              <td className="py-1.5 pr-3 text-slate-300">{k.competition ? `${Math.round(k.competition.lowShare * 100)}%` : "—"}</td>
              <td className="py-1.5 pr-3 text-slate-300">{k.competition?.avgPrice ? `$${k.competition.avgPrice.toFixed(2)}` : "—"}</td>
              <td className="py-1.5">
                {k.score !== undefined ? (
                  <div className="flex items-center gap-1.5">
                    <Bar value={k.score} tone="bg-emerald-500" />
                    <span className="text-emerald-300">{k.score}</span>
                  </div>
                ) : (
                  <span className="text-slate-600">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 15 && (
        <button onClick={() => setAll((a) => !a)} className="mt-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          {all ? "Show fewer" : `Show all ${rows.length} phrases`}
        </button>
      )}
    </div>
  );
}

function ResearchView({ id, onStart, onGone }: { id: string; onStart: (c: Concept) => void; onGone: () => void }) {
  const [r, setR] = useState<Research | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<Research>(`/api/research/${id}`)
      .then(setR)
      .catch((e) => setError(errText(e)));
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!r || !running(r)) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [r, load]);
  if (!r) return <p className="text-sm text-slate-500">{error ?? "Loading…"}</p>;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h3 className="text-base font-semibold text-slate-100">“{r.seed}”</h3>
          <p className="text-xs text-slate-500">
            Amazon {r.market === "kindle" ? "Kindle ebooks" : "books"} · {new Date(r.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </p>
        </div>
        {!running(r) && (
          <button
            onClick={() => {
              if (confirm(`Delete the research for “${r.seed}”?`)) void send("DELETE", `/api/research/${r.id}`).then(onGone, (e) => setError(errText(e)));
            }}
            className={`${btn} text-slate-500 hover:text-rose-300`}
          >
            Delete
          </button>
        )}
      </div>
      {running(r) && <p className="text-xs text-cyan-300 rounded border border-cyan-900 bg-slate-950 px-3 py-2">{r.progress ?? "Starting…"}</p>}
      {r.error && <p className="text-xs text-rose-300 rounded border border-rose-900 bg-rose-950/40 px-3 py-2">{r.error}</p>}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {r.notes.length > 0 && (
        <ul className="text-[11px] text-amber-300/90 list-disc pl-5">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {r.concepts && (
        <section className="space-y-2">
          <h4 className="text-sm font-medium text-slate-200">Book ideas</h4>
          {r.summary && <p className="text-xs text-slate-400">{r.summary}</p>}
          <div className="grid md:grid-cols-3 gap-3">
            {r.concepts.map((c) => (
              <div key={c.title} className="rounded border border-slate-800 bg-slate-950/60 p-3 flex flex-col gap-1.5">
                <span className="text-[10px] uppercase text-cyan-400">{KIND_LABEL[c.kind]}</span>
                <p className="text-sm font-medium text-slate-100">{c.title}</p>
                {c.keyword && <p className="text-[11px] text-slate-500">Targets “{c.keyword}”</p>}
                <p className="text-xs text-slate-300">{c.angle}</p>
                {c.audience && <p className="text-[11px] text-slate-400">For: {c.audience}</p>}
                <p className="text-[11px] text-slate-500 flex-1">{c.why}</p>
                <button onClick={() => onStart(c)} className={`${primary} self-start mt-1`}>
                  Start this book
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {r.keywords.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-sm font-medium text-slate-200">What buyers search for</h4>
          <KeywordTable r={r} />
          <p className="text-[11px] text-slate-500">
            Demand comes from Amazon's own search suggestions (how early and how often a phrase is suggested). It's a relative signal, not a search volume. Competition is read from the first page of results: under 100 reviews
            and a low median usually means room for a new book. Sales ranks aren't read.
          </p>
        </section>
      )}
    </div>
  );
}

/** The research page: start new research, pick earlier research, read the results. */
export default function BookResearch({ onStart }: { onStart: (c: Concept) => void }) {
  const proj = useProjects();
  const [items, setItems] = useState<Research[]>([]);
  const [browser, setBrowser] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [seed, setSeed] = useState("");
  const [market, setMarket] = useState<"books" | "kindle">("books");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<{ items: Research[]; browser: boolean }>(`/api/research${proj.query ? `?${proj.query}` : ""}`)
      .then((r) => {
        setItems(r.items);
        setBrowser(r.browser);
        setSelected((s) => s ?? r.items[0]?.id ?? null);
      })
      .catch((e) => setError(errText(e)));
  }, [proj.query]);
  useEffect(() => {
    load();
  }, [load]);
  const start = async () => {
    setError(null);
    try {
      const r = await send<Research>("POST", "/api/research", { seed, market, project: proj.target });
      setSeed("");
      setSelected(r.id);
      load();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <div className="max-w-4xl space-y-5">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-100">Find a niche</h2>
        <p className="text-xs text-slate-500">
          Reads what buyers type into Amazon's search box for your niche, checks how crowded the first page of results is, then has the Writer suggest three books worth making.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && seed.trim().length >= 3 && void start()}
            maxLength={80}
            className={`${input} flex-1 min-w-56`}
            placeholder="A niche: dog training, cozy mystery, budget planner, bedtime stories…"
            aria-label="Niche"
          />
          <select value={market} onChange={(e) => setMarket(e.target.value as "books" | "kindle")} className="bg-slate-950 border border-slate-700 rounded px-2 text-sm text-slate-200" aria-label="Market">
            <option value="books">Amazon books</option>
            <option value="kindle">Kindle ebooks</option>
          </select>
          <button disabled={seed.trim().length < 3} onClick={() => void start()} className={primary}>
            Research
          </button>
        </div>
        {!browser && <p className="text-[11px] text-amber-300/90">Without the browser sidecar (BROWSER_CDP_URL) only demand is read, not competition.</p>}
        {error && <p className="text-xs text-rose-300">{error}</p>}
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((r) => (
            <button key={r.id} onClick={() => setSelected(r.id)} className={`${btn} border ${selected === r.id ? "border-cyan-600 bg-cyan-950 text-cyan-300" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
              {r.seed}
              {running(r) ? " …" : r.status === "failed" ? " ✕" : ""}
            </button>
          ))}
        </div>
      )}
      {selected && (
        <ResearchView
          key={selected}
          id={selected}
          onStart={onStart}
          onGone={() => {
            setSelected(null);
            load();
          }}
        />
      )}
      {!items.length && <p className={`${quiet} inline-block border-dashed text-slate-500`}>No research yet.</p>}
    </div>
  );
}
