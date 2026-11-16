import { useState } from "react";
import type { ReactNode } from "react";

// Navigation: an icon rail down the left on desktop, and a tab bar with a mic
// button along the bottom on phones.

export type View = "home" | "console" | "board" | "routines" | "skills" | "assets" | "files" | "team" | "projects";
export const VIEWS: View[] = ["home", "console", "board", "routines", "skills", "assets", "files", "team", "projects"];

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
    {d}
  </svg>
);

const ITEMS: { view: View; label: string; icon: ReactNode }[] = [
  { view: "home", label: "Home", icon: icon(<path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10" />) },
  { view: "console", label: "Console", icon: icon(<><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="m7 10 3 2.5L7 15M12.5 15H17" /></>) },
  { view: "board", label: "Board", icon: icon(<><rect x="3.5" y="4" width="4.5" height="16" rx="1" /><rect x="9.75" y="4" width="4.5" height="10" rx="1" /><rect x="16" y="4" width="4.5" height="13" rx="1" /></>) },
  { view: "routines", label: "Routines", icon: icon(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>) },
  { view: "skills", label: "Skills", icon: icon(<path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5-2-6.5-6.5-2L10 10z" />) },
  { view: "assets", label: "Assets", icon: icon(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" /></>) },
  { view: "files", label: "Files", icon: icon(<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />) },
  { view: "team", label: "Team", icon: icon(<><circle cx="9" cy="9" r="3" /><path d="M3.5 19c.6-3 2.7-4.5 5.5-4.5s4.900 1.500 5.500 4.500M16 6.500a2.800 2.800 0 0 1 0 5.500M17.500 14.800c1.700.5 2.700 1.900 3 4.200" /></>) },
  { view: "projects", label: "Projects", icon: icon(<path d="m12 4 8.500 4.500L12 13 3.500 8.500zM3.500 12.500 12 17l8.500-4.500M3.500 16.500 12 21l8.500-4.500" />) },
];

const MicIcon = () =>
  icon(
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>,
  );

/** Desktop: icons down the left edge. */
export function Rail({ view, onView, connection }: { view: View; onView: (v: View) => void; connection: string }) {
  return (
    <nav className="hidden md:flex flex-col items-center gap-1.5 w-14 shrink-0 py-4 border-r border-slate-800 bg-slate-950" aria-label="Pages">
      <div
        className="h-9 w-9 mb-3 rounded-lg border border-cyan-600 text-cyan-400 text-[11px] font-bold flex items-center justify-center relative"
        title={`Mission Control · harness ${connection}`}
      >
        HQ
        <span className={`absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full ring-2 ring-slate-950 ${connection === "open" ? "bg-emerald-400" : connection === "connecting" ? "bg-amber-400" : "bg-cyan-500 animate-pulse"}`} />
      </div>
      {ITEMS.map((it, i) => (
        <button
          key={it.view}
          onClick={() => onView(it.view)}
          title={it.label}
          aria-label={it.label}
          aria-current={view === it.view ? "page" : undefined}
          className={`h-9 w-9 rounded-lg flex items-center justify-center ${i === ITEMS.length - 1 ? "mt-auto" : ""} ${
            view === it.view ? "bg-cyan-950 text-cyan-400 border border-cyan-800" : "text-slate-500 hover:text-slate-200 hover:bg-slate-900"
          }`}
        >
          {it.icon}
        </button>
      ))}
    </nav>
  );
}

/** Phones: Home, Board, the mic, Console and a menu with every page. */
export function TabBar({ view, onView, onMic }: { view: View; onView: (v: View) => void; onMic: () => void }) {
  const [menu, setMenu] = useState(false);
  const tab = (v: View) => {
    const it = ITEMS.find((x) => x.view === v)!;
    return (
      <button
        key={v}
        onClick={() => {
          setMenu(false);
          onView(v);
        }}
        aria-label={it.label}
        aria-current={view === v ? "page" : undefined}
        className={`h-11 w-11 rounded-xl flex items-center justify-center ${view === v ? "bg-cyan-950 text-cyan-400" : "text-slate-500"}`}
      >
        {it.icon}
      </button>
    );
  };
  return (
    <>
      {menu && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/70" onClick={() => setMenu(false)}>
          <div className="absolute bottom-20 inset-x-3 bg-slate-900 border border-slate-800 rounded-2xl p-3 grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
            {ITEMS.map((it) => (
              <button
                key={it.view}
                onClick={() => {
                  setMenu(false);
                  onView(it.view);
                }}
                className={`flex flex-col items-center gap-1 py-3 rounded-xl text-[11px] ${view === it.view ? "bg-cyan-950 text-cyan-400" : "text-slate-300 bg-slate-950"}`}
              >
                {it.icon}
                {it.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 h-16 px-4 pb-[env(safe-area-inset-bottom)] bg-slate-950/95 backdrop-blur border-t border-slate-800 flex items-center justify-between" aria-label="Pages">
        {tab("home")}
        {tab("board")}
        <button onClick={onMic} aria-label="Talk to Jarvis" className="h-12 w-12 rounded-full bg-cyan-500 text-white flex items-center justify-center shadow-lg shadow-cyan-900/60 active:bg-cyan-400">
          <MicIcon />
        </button>
        {tab("console")}
        <button onClick={() => setMenu((m) => !m)} aria-label="All pages" aria-expanded={menu} className={`h-11 w-11 rounded-xl flex items-center justify-center ${menu ? "bg-slate-800 text-slate-100" : "text-slate-500"}`}>
          {icon(<path d="M4 7h16M4 12h16M4 17h16" />)}
        </button>
      </nav>
    </>
  );
}
