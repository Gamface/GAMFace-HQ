import { useEffect, useRef, useState } from "react";
import { getJson, send } from "../api";

// Header pill for things that didn't stop the work but you should know about:
// a budget was reached, a local-only agent was kept off the cloud, a price is missing.

interface Notice {
  id: string;
  kind: string;
  message: string;
  lastAt: number;
  count: number;
}

const ICON: Record<string, string> = { budget: "💸", "local-only": "🔒", "price-missing": "🏷", fallback: "↪", "read-only": "👁", routine: "⏱", skill: "✨" };

export default function NoticesBar() {
  const [list, setList] = useState<Notice[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = () =>
    getJson<Notice[]>("/api/notices")
      .then(setList)
      .catch(() => {});

  useEffect(() => {
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (!list.length) return null;
  const dismiss = async (id?: string) => {
    await send("POST", "/api/notices/dismiss", id ? { id } : {}).catch(() => {});
    void load();
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-3 py-1 rounded-md border border-amber-700 bg-amber-950/70 text-amber-200 text-sm font-mono whitespace-nowrap"
        title="Budget, local-only and fallback notices"
      >
        ⚠ {list.length} notice{list.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 w-[28rem] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl p-2 space-y-1">
          {list.map((n) => (
            <div key={n.id} className="flex gap-2 items-start text-xs p-2 rounded hover:bg-slate-800/60">
              <span>{ICON[n.kind] ?? "•"}</span>
              <div className="flex-1 text-slate-300">
                {n.message}
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {new Date(n.lastAt).toLocaleString()}
                  {n.count > 1 ? ` · ${n.count} times` : ""}
                </div>
              </div>
              <button onClick={() => void dismiss(n.id)} className="text-slate-500 hover:text-slate-200" title="Dismiss">
                ✕
              </button>
            </div>
          ))}
          <button onClick={() => void dismiss()} className="w-full text-[11px] text-slate-500 hover:text-slate-300 pt-1">
            Dismiss all
          </button>
        </div>
      )}
    </div>
  );
}
