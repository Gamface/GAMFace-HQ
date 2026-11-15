import { useEffect, useRef, useState } from "react";
import { getJson, send } from "../api";

// Live view of the browser agent's Chrome: the screen (a JPEG screencast), the
// address bar and each action. You can take over a running agent's browser (to
// sign in, pass a check…) and hand it back, and open a browser profile yourself to
// sign in to sites ahead of time. Profiles keep their sign-ins between runs.

interface BrowserAction {
  kind: string;
  line: string;
  ts: number;
}

type Event =
  | { type: "frame"; taskId: string; data: string; url: string; title: string }
  | { type: "start" | "end"; taskId: string; task?: string }
  | { type: "action"; taskId: string; kind: string; line: string }
  | { type: "blocked"; taskId: string; url: string; reason: string }
  | { type: "control"; taskId: string; state: "agent" | "user"; by?: "user" | "agent"; reason?: string; profile?: string; manual?: boolean; readOnly?: boolean };

interface Session {
  id: string;
  title: string;
  profile?: string;
  readOnly: boolean;
  manual: boolean;
  control: "agent" | "user";
  by?: "user" | "agent";
  reason?: string;
  url: string;
}

interface Profile {
  name: string;
  cookies: number;
  sites: string[];
  savedAt?: number;
  open: boolean;
}

const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Delete", "Home", "End", "PageUp", "PageDown"]);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");

function ProfilesPanel({ onOpened }: { onOpened: () => void }) {
  const [list, setList] = useState<Profile[]>([]);
  const [def, setDef] = useState("");
  const [encrypted, setEncrypted] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    getJson<{ profiles: Profile[]; default: string; encrypted: boolean }>("/api/profiles")
      .then((d) => {
        setList(d.profiles);
        setDef(d.default);
        setEncrypted(d.encrypted);
      })
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void load();
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <div className="p-4 space-y-3 text-xs overflow-y-auto">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Browser profiles</h3>
        <p className="text-slate-500">
          Each profile keeps its own sign-ins between runs. Open one to sign in to sites yourself; cards and routines that may act browse with the default profile, or the one they pick. Read-only runs never use a profile.
          {encrypted ? " Sign-ins are encrypted on disk." : " Set PROFILE_SECRET to encrypt sign-ins on disk."}
        </p>
      </div>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Page to open, e.g. https://www.amazon.com (optional)"
        className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200"
      />
      <ul className="space-y-1.5">
        {list.map((p) => (
          <li key={p.name} className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded px-2 py-1.5">
            <span className="font-mono text-slate-100">{p.name}</span>
            {p.name === def && <span className="px-1.5 rounded bg-cyan-800 text-cyan-100 text-[10px]">default</span>}
            <span className="text-slate-500 truncate" title={p.sites.join(", ")}>
              {p.cookies ? `${p.cookies} sign-in cookie${p.cookies === 1 ? "" : "s"} · ${p.sites.slice(0, 3).join(", ")}${p.sites.length > 3 ? "…" : ""}` : "no sign-ins yet"}
            </span>
            <div className="ml-auto flex gap-1.5 shrink-0">
              <button
                onClick={() => void act(async () => (await send("POST", `/api/profiles/${p.name}/open`, { url }), onOpened()))}
                className="px-2 py-0.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white"
              >
                {p.open ? "Show" : "Open"}
              </button>
              {p.name !== def && (
                <button onClick={() => void act(() => send("PUT", "/api/profiles/default", { name: p.name }))} className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">
                  Make default
                </button>
              )}
              {p.name !== def && (
                <button
                  onClick={() => confirm(`Delete the profile “${p.name}” and its sign-ins?`) && void act(() => send("DELETE", `/api/profiles/${p.name}`))}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-rose-900 text-slate-400"
                >
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await send("POST", "/api/profiles", { name: name.trim().toLowerCase() });
            setName("");
          });
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new-profile-name" maxLength={32} className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 font-mono" />
        <button type="submit" disabled={!name.trim()} className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 disabled:opacity-40">
          + Add profile
        </button>
      </form>
      {error && <p className="text-rose-300">{error}</p>}
    </div>
  );
}

export default function BrowserPane({
  baseUrl,
  enabled,
  visible,
  onStart,
}: {
  baseUrl: string;
  enabled: boolean;
  visible: boolean;
  onStart: () => void;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [live, setLive] = useState(false);
  const [actions, setActions] = useState<BrowserAction[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [showProfiles, setShowProfiles] = useState(false);
  const [address, setAddress] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const keysRef = useRef<HTMLDivElement>(null);
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;

  const loadSessions = () =>
    getJson<Session[]>("/api/browser/sessions")
      .then((s) => {
        setSessions(s);
        setCurrent((c) => (c && s.some((x) => x.id === c) ? c : s[s.length - 1]?.id ?? null));
      })
      .catch(() => {});

  // Stay connected even while hidden, so the tab can open itself when browsing starts
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(`${baseUrl}/api/browser/stream`);
    let replaying = true;
    setTimeout(() => (replaying = false), 500);
    source.onmessage = (message) => {
      const e = JSON.parse(message.data) as Event;
      if (e.type === "frame") {
        setFrame(`data:image/jpeg;base64,${e.data}`);
        setUrl(e.url);
        setTitle(e.title);
      } else if (e.type === "start") {
        setLive(true);
        setTask(e.task ?? "");
        setActions([]);
        setCurrent(e.taskId);
        if (!replaying) onStartRef.current();
        void loadSessions();
      } else if (e.type === "end") {
        setLive(false);
        void loadSessions();
      } else if (e.type === "action") {
        setActions((prev) => [...prev.slice(-40), { kind: e.kind, line: e.line, ts: Date.now() }]);
      } else if (e.type === "blocked") {
        setActions((prev) => [...prev.slice(-40), { kind: "blocked", line: `Blocked ${e.url} (${e.reason})`, ts: Date.now() }]);
      } else if (e.type === "control") {
        void loadSessions();
        if (e.state === "user" && e.by === "agent" && !replaying) onStartRef.current();
      }
    };
    void loadSessions();
    const t = setInterval(() => void loadSessions(), 3000);
    return () => {
      source.close();
      clearInterval(t);
    };
  }, [baseUrl, enabled]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [actions.length]);

  const s = sessions.find((x) => x.id === current) ?? null;
  const mine = s?.control === "user";

  // Focus the page when you get control, so typing goes to it
  useEffect(() => {
    if (mine) keysRef.current?.focus();
  }, [mine, current]);

  const call = async (path: string, body: unknown = {}) => {
    setError(null);
    try {
      await send("POST", path, body);
      await loadSessions();
    } catch (e) {
      setError(errText(e));
    }
  };
  // Your input goes straight through; the screen updates from the live stream
  const input = async (body: Record<string, unknown>) => {
    if (!s) return;
    try {
      await send("POST", `/api/browser/${s.id}/input`, body);
    } catch (e) {
      setError(errText(e));
    }
  };

  if (!visible) return null;
  if (!enabled) {
    return (
      <div className="p-6 text-slate-500 text-sm font-mono space-y-2">
        <p>// Real browsing is off.</p>
        <p>// Start the Chrome container with the updated docker-compose.yml (it sets BROWSER_CDP_URL), then send a task to the browser agent.</p>
      </div>
    );
  }

  const color = (kind: string) =>
    kind === "action" ? "text-cyan-400" : kind === "error" ? "text-rose-400" : kind === "blocked" ? "text-amber-400" : "text-slate-500";

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 bg-slate-950/60 text-xs font-mono">
        <span className={`h-2.5 w-2.5 rounded-full ${live ? "bg-rose-500 animate-pulse" : "bg-slate-600"}`} />
        <span className={live ? "text-rose-400" : "text-slate-500"}>{live ? "LIVE" : "IDLE"}</span>
        {mine ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setEditingAddress(false);
              void input({ type: "navigate", url: address });
            }}
          >
            <input
              value={editingAddress ? address : url}
              onFocus={() => {
                setAddress(url);
                setEditingAddress(true);
              }}
              onBlur={() => setEditingAddress(false)}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full bg-slate-900 border border-cyan-700 rounded px-3 py-1 text-slate-200"
            />
          </form>
        ) : (
          <div className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-1 text-slate-300 truncate" title={url}>
            {url || "about:blank"}
          </div>
        )}
        {s?.profile && <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300" title="Browser profile (its sign-ins)">👤 {s.profile}</span>}
        {s && !s.readOnly && !mine && (
          <button onClick={() => void call(`/api/browser/${s.id}/takeover`)} className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-sans">
            Take over
          </button>
        )}
        {s && mine && (
          <button onClick={() => void input({ type: "back" })} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-sans" title="Back">
            ←
          </button>
        )}
        {s && mine && !s.manual && (
          <button onClick={() => void call(`/api/browser/${s.id}/handback`)} className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-sans">
            Hand back
          </button>
        )}
        {s?.manual && (
          <button onClick={() => void call(`/api/browser/${s.id}/close`)} className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-sans">
            Close & save
          </button>
        )}
        <button onClick={() => setShowProfiles((v) => !v)} className={`px-2 py-1 rounded font-sans ${showProfiles ? "bg-slate-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
          Profiles
        </button>
      </div>
      {sessions.length > 1 && (
        <div className="flex gap-1 px-3 py-1 border-b border-slate-800 text-[11px]">
          {sessions.map((x) => (
            <button key={x.id} onClick={() => setCurrent(x.id)} className={`px-2 py-0.5 rounded ${x.id === current ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"}`}>
              {x.manual ? `👤 ${x.profile}` : x.title.slice(0, 30)}
              {x.control === "user" ? " ⏸" : ""}
            </button>
          ))}
        </div>
      )}
      {s && mine && s.by === "agent" && (
        <div className="px-3 py-2 bg-amber-950/60 border-b border-amber-700/60 text-xs text-amber-100">
          🙋 The agent asks: <b>{s.reason}</b>. You have the browser: do it, then press <b>Hand back</b>.
        </div>
      )}
      {s && mine && s.by !== "agent" && (
        <div className="px-3 py-1.5 bg-cyan-950/50 border-b border-cyan-800/60 text-[11px] text-cyan-100">
          {s.manual ? "Your profile window: " : "You have the browser and the agent is waiting: "}
          click the page, type, scroll, or enter an address above. Nothing you do here asks for approval.
        </div>
      )}
      {task && !showProfiles && <div className="px-3 py-1 text-[11px] text-slate-500 truncate border-b border-slate-800">Task: {task}</div>}
      {error && <div className="px-3 py-1 text-[11px] text-rose-300 border-b border-slate-800">{error}</div>}
      {showProfiles ? (
        <ProfilesPanel onOpened={() => setShowProfiles(false)} />
      ) : (
        <div
          ref={keysRef}
          tabIndex={0}
          onKeyDown={(e) => {
            if (!mine || editingAddress) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (KEYS.has(e.key)) {
              e.preventDefault();
              void input({ type: "key", key: e.key });
            } else if (e.key.length === 1) {
              e.preventDefault();
              void input({ type: "type", text: e.key });
            }
          }}
          onPaste={(e) => {
            if (!mine) return;
            const text = e.clipboardData?.getData("text") ?? "";
            if (text) {
              e.preventDefault();
              void input({ type: "type", text });
            }
          }}
          className={`flex-1 min-h-0 flex items-center justify-center bg-black outline-none ${mine ? "ring-2 ring-inset ring-cyan-500" : ""}`}
        >
          {frame ? (
            <img
              ref={imgRef}
              src={frame}
              alt={title || "Browser view"}
              draggable={false}
              onClick={(e) => {
                if (!mine || !imgRef.current) return;
                const r = imgRef.current.getBoundingClientRect();
                const w = imgRef.current.naturalWidth || 1280;
                const h = imgRef.current.naturalHeight || 800;
                keysRef.current?.focus();
                void input({ type: "click", x: ((e.clientX - r.left) * w) / r.width, y: ((e.clientY - r.top) * h) / r.height });
              }}
              onWheel={(e) => mine && void input({ type: "scroll", dy: e.deltaY })}
              className={`max-w-full max-h-full object-contain ${mine ? "cursor-pointer" : ""}`}
            />
          ) : (
            <p className="text-slate-600 italic text-sm font-mono">// Waiting for the browser agent. Ask it to look something up, or open a profile to sign in.</p>
          )}
        </div>
      )}
      <div ref={logRef} className="h-28 overflow-y-auto border-t border-slate-800 bg-slate-950 p-2 font-mono text-[11px] space-y-0.5">
        {actions.length === 0 && <div className="text-slate-600">No actions yet.</div>}
        {actions.map((a, i) => (
          <div key={i} className={color(a.kind)}>
            {a.kind === "action" ? "🌐 " : "   "}
            {a.line}
          </div>
        ))}
      </div>
    </div>
  );
}
