import { HARNESS_URL, authHeaders } from "./config";

// Small helpers shared by the Board, card drawer and Team page.

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HARNESS_URL}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Sends a change and returns the JSON reply, throwing the server's error message on failure. */
export async function send<T = unknown>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
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

/** Uploads a picture and returns its id, for a card's "images". */
export async function uploadImage(file: Blob): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Only pictures can be attached");
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the picture"));
    r.readAsDataURL(file);
  });
  const out = await send<{ id: string }>("POST", "/api/uploads", { data });
  return out.id;
}

export const imageUrl = (id: string) => `${HARNESS_URL}/api/uploads/${id}`;
export const uploadUrl = imageUrl;
/** What an empty task box means when only attachments were given. */
export function defaultPrompt(audio: number, documents: number): string {
  if (documents && !audio) return `Summarize the attached PDF${documents > 1 ? "s" : ""}.`;
  return "Listen to the attached audio and respond.";
}

export interface DocInfo {
  id: string;
  name: string;
  pages: number;
  scanned?: boolean;
}

/** Uploads a PDF; the harness reads it right away, so a broken or locked file fails here. */
export async function uploadPdf(file: File): Promise<DocInfo> {
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
  return send<DocInfo>("POST", "/api/uploads", { data, kind: "pdf", name: file.name });
}

export const fileUrl = (name: string, download = false) => `${HARNESS_URL}/api/files/${name}${download ? "?download=1" : ""}`;

export interface CardFile {
  name: string;
  bytes: number;
  pictures?: number;
  at: number;
}

/** Converts audio to 16 kHz mono WAV in the browser, uploads it, and returns its id and length. */
export async function uploadAudio(file: Blob): Promise<{ id: string; seconds: number }> {
  const { toWav16kMono } = await import("./audio");
  const { wav, seconds } = await toWav16kMono(file);
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the audio"));
    r.readAsDataURL(wav);
  });
  const out = await send<{ id: string; seconds?: number }>("POST", "/api/uploads", { data, kind: "audio" });
  return { id: out.id, seconds: out.seconds ?? seconds };
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
  vision: "Vision",
  audio: "Transcriber",
  router: "Router",
  memory: "Memory",
};

export const AGENT_COLORS: Record<string, string> = {
  planner: "bg-cyan-800/70 text-cyan-100",
  coder: "bg-violet-800/70 text-violet-100",
  browser: "bg-sky-800/70 text-sky-100",
  file: "bg-amber-800/70 text-amber-100",
  security_audit: "bg-rose-800/70 text-rose-100",
  vision: "bg-emerald-800/70 text-emerald-100",
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
  deliverTo?: "dashboard" | "telegram" | "obsidian";
  allowedSites?: string[];
  usedPrivate?: boolean;
  images?: string[];
  audio?: string[];
  replies?: number;
  files?: CardFile[];
  documents?: string[];
  awaitingApproval?: string;
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
