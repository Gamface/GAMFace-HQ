import { useEffect, useRef, useState } from "react";

// Live view of the browser agent's Chrome: the screen (as a JPEG screencast),
// the address bar, and each action the agent takes.

interface BrowserAction {
  kind: string;
  line: string;
  ts: number;
}

type Event =
  | { type: "frame"; taskId: string; data: string; url: string; title: string }
  | { type: "start" | "end"; taskId: string; task?: string }
  | { type: "action"; taskId: string; kind: string; line: string }
  | { type: "blocked"; taskId: string; url: string; reason: string };

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
  const logRef = useRef<HTMLDivElement>(null);
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;

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
        if (!replaying) onStartRef.current();
      } else if (e.type === "end") {
        setLive(false);
      } else if (e.type === "action") {
        setActions((prev) => [...prev.slice(-40), { kind: e.kind, line: e.line, ts: Date.now() }]);
      } else if (e.type === "blocked") {
        setActions((prev) => [...prev.slice(-40), { kind: "blocked", line: `Blocked ${e.url} (${e.reason})`, ts: Date.now() }]);
      }
    };
    return () => source.close();
  }, [baseUrl, enabled]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [actions.length]);

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
        <div className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-1 text-slate-300 truncate" title={url}>
          {url || "about:blank"}
        </div>
      </div>
      {task && <div className="px-3 py-1 text-[11px] text-slate-500 truncate border-b border-slate-800">Task: {task}</div>}
      <div className="flex-1 min-h-0 flex items-center justify-center bg-black">
        {frame ? (
          <img src={frame} alt={title || "Browser view"} className="max-w-full max-h-full object-contain" />
        ) : (
          <p className="text-slate-600 italic text-sm font-mono">// Waiting for the browser agent. Ask it to look something up.</p>
        )}
      </div>
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
