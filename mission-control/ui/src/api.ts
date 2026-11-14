import { HARNESS_URL, authHeaders } from "./config";

// Small helpers shared by the Board, card drawer and Team page.

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HARNESS_URL}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Sends a change and returns the JSON reply, throwing the server's error message on failure. */
export async function send<T = unknown>(method: "POST" | "PATCH" | "PUT", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HARNESS_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: unknown }).error;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err ?? res.status));
  }
  return data as T;
}

/** "ollama/qwen2.5-coder:14b" → { name: "qwen2.5-coder:14b", provider: "ollama" } */
export function splitModel(ref?: string | null): { name: string; provider: string } {
  if (!ref) return { name: "auto", provider: "" };
  const i = ref.indexOf("/");
  return i > 0 ? { name: ref.slice(i + 1), provider: ref.slice(0, i) } : { name: ref, provider: "ollama" };
}

export const AGENT_LABELS: Record<string, string> = {
  auto: "Auto-route",
  planner: "Jarvis",
  coder: "Coder",
  browser: "Browser",
  file: "File",
  security_audit: "Security",
  router: "Router",
  memory: "Memory",
};

export const AGENT_COLORS: Record<string, string> = {
  planner: "bg-cyan-800/70 text-cyan-100",
  coder: "bg-violet-800/70 text-violet-100",
  browser: "bg-sky-800/70 text-sky-100",
  file: "bg-amber-800/70 text-amber-100",
  security_audit: "bg-rose-800/70 text-rose-100",
};

export interface SubtaskCard {
  id: string;
  title?: string;
  targetAgent: string;
  status: string;
  model: string;
}

export interface BoardCard {
  id: string;
  title?: string;
  prompt: string;
  targetAgent: string;
  routedBy?: string;
  source: string;
  status: string;
  column: "backlog" | "ready" | "running" | "review" | "done" | "failed";
  priority?: "low" | "normal" | "high";
  dependsOn?: string[];
  waitingOn: string[];
  needsReview?: boolean;
  readOnly?: boolean;
  allowedSites?: string[];
  usedPrivate?: boolean;
  interrupted?: boolean;
  attempts?: number;
  position?: number;
  createdAt: number;
  finishedAt?: number;
  plannedModel: string | null;
  subtasks: SubtaskCard[];
  preview: string;
  error?: string;
}

export interface Board {
  columns: BoardCard["column"][];
  cards: BoardCard[];
  running: string | null;
}
