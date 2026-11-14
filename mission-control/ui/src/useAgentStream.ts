import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatus, AgentStreamPayload, TaskSource } from "../../src/schemas/agent";

export type Connection = "connecting" | "open" | "reconnecting";

export interface TaskView {
  id: string;
  title: string;
  agent: string;
  source?: TaskSource;
  status: AgentStatus;
  output: string;
  createdAt: number;
  updatedAt: number;
}

export const TERMINAL: readonly AgentStatus[] = ["complete", "canceled", "error"];

// Subscribes to the harness event stream and folds events into per-task views.
// EventSource reconnects on its own and sends Last-Event-ID, so the harness
// replays anything missed; duplicates are dropped by eventId.
export function useAgentStream(baseUrl: string) {
  const [events, setEvents] = useState<AgentStreamPayload[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const seen = useRef(new Set<number>());

  useEffect(() => {
    const source = new EventSource(`${baseUrl}/api/agent/stream?replay=all`);
    source.onopen = () => setConnection("open");
    source.onerror = () => setConnection("reconnecting");
    source.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data) as AgentStreamPayload;
        if (seen.current.has(payload.eventId)) return;
        seen.current.add(payload.eventId);
        setEvents((prev) => [...prev, payload]);
      } catch (err) {
        console.error("Malformed SSE frame:", err);
      }
    };
    return () => source.close();
  }, [baseUrl]);

  const tasks = useMemo(() => {
    const byId = new Map<string, TaskView>();
    for (const e of events) {
      let task = byId.get(e.taskId);
      if (!task) {
        const title = e.logChunk.replace(/^>\s*/, "").trim().split("\n")[0] || e.taskId.slice(0, 8);
        task = { id: e.taskId, title, agent: e.activeSubAgent, source: e.source, status: e.status, output: "", createdAt: e.timestamp, updatedAt: e.timestamp };
        byId.set(e.taskId, task);
      }
      task.status = e.status;
      task.agent = e.activeSubAgent;
      task.output += e.logChunk;
      task.updatedAt = e.timestamp;
    }
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [events]);

  // Status changes only, for the telemetry feed (token chunks would flood it)
  const statusEvents = useMemo(() => events.filter((e) => e.status !== "streaming"), [events]);

  return { connection, tasks, statusEvents };
}
