import type { ChatMessage } from "./ollama";
import { parseJsonLoose } from "./ollama";

// Where models come from. Two kinds cover almost everything:
//   ollama  - Ollama's native API (thinking switch, keep-alive, context size)
//   openai  - any OpenAI-compatible endpoint: LM Studio, OpenAI, OpenRouter,
//             Gemini and Anthropic's compatibility endpoints, vLLM, etc.
// API keys are read from environment variables (.env) by name and never
// stored in the database or sent to the dashboard.

export interface Provider {
  id: string;
  name: string;
  kind: "ollama" | "openai";
  baseUrl: string;
  /** Name of the env var holding the API key (cloud providers) */
  apiKeyEnv?: string;
  /** Runs on your own hardware */
  local: boolean;
}

export interface ChatOptions {
  numCtx?: number;
  temperature?: number;
  /** false switches reasoning off on models that support it */
  think?: boolean;
  keepAlive?: string;
  maxTokens?: number;
  json?: boolean;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export function builtinProviders(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const list: Provider[] = [
    { id: "ollama", name: "Ollama (local GPU)", kind: "ollama", baseUrl: (env.OLLAMA_BASE_URL || "http://127.0.0.1:11435").replace(/\/+$/, ""), local: true },
  ];
  if (env.LMSTUDIO_BASE_URL) list.push({ id: "lmstudio", name: "LM Studio (local)", kind: "openai", baseUrl: env.LMSTUDIO_BASE_URL.replace(/\/+$/, ""), local: true });
  // colibri runs large mixture-of-experts models on your own hardware, streaming
  // rarely used experts from disk. OpenAI-compatible, and local, so private context is allowed.
  if (env.COLIBRI_BASE_URL) list.push({ id: "colibri", name: "colibri (local)", kind: "openai", baseUrl: env.COLIBRI_BASE_URL.replace(/\/+$/, ""), local: true });
  const cloud: [string, string, string, string][] = [
    ["openai", "OpenAI", "https://api.openai.com/v1", "OPENAI_API_KEY"],
    ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"],
    ["anthropic", "Anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"],
    ["gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"],
  ];
  for (const [id, name, baseUrl, keyEnv] of cloud) {
    if (env[keyEnv]) list.push({ id, name, kind: "openai", baseUrl, apiKeyEnv: keyEnv, local: false });
  }
  return list;
}

/** "openrouter/anthropic/claude-sonnet-4.5" → provider openrouter, model "anthropic/claude-sonnet-4.5". Bare names mean Ollama. */
export function parseModelRef(ref: string, providers: Provider[]): { provider: Provider; model: string } | null {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const p = providers.find((x) => x.id === ref.slice(0, slash));
    if (p) return { provider: p, model: ref.slice(slash + 1) };
  }
  const ollama = providers.find((x) => x.id === "ollama");
  // A slash with an unknown prefix could be an Ollama namespace (e.g. "library/qwen3"), but only if Ollama exists
  return ollama ? { provider: ollama, model: ref } : null;
}

export function normalizeRef(ref: string, providers: Provider[]): string | null {
  const parsed = parseModelRef(ref, providers);
  return parsed ? `${parsed.provider.id}/${parsed.model}` : null;
}

function headers(p: Provider): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
  if (key) h.Authorization = `Bearer ${key}`;
  if (p.id === "openrouter") {
    h["HTTP-Referer"] = "http://localhost";
    h["X-Title"] = "Mission Control";
  }
  return h;
}

// --- Pictures ------------------------------------------------------------------------
/** Ollama takes base64 pictures on the message; OpenAI-compatible APIs take content parts. */
function toProviderMessages(p: Provider, messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (!m.images?.length) return { role: m.role, content: m.content };
    if (p.kind === "ollama") return { role: m.role, content: m.content, images: m.images };
    return {
      role: m.role,
      content: [
        { type: "text", text: m.content },
        ...m.images.map((b64) => ({ type: "image_url", image_url: { url: `data:${imageMime(b64)};base64,${b64}` } })),
      ],
    };
  });
}

function imageMime(b64: string): string {
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("R0lG")) return "image/gif";
  if (b64.startsWith("UklG")) return "image/webp";
  return "image/png";
}

const visionSupport = new Map<string, boolean>();

/** Whether a model can read pictures. Ollama reports it; OpenAI-compatible providers are assumed able. */
export async function supportsVision(p: Provider, model: string): Promise<boolean> {
  if (p.kind !== "ollama") return true;
  const key = `${p.baseUrl}|${model}`;
  if (visionSupport.has(key)) return visionSupport.get(key)!;
  try {
    const res = await fetch(`${p.baseUrl}/api/show`, { method: "POST", headers: headers(p), body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
    const info = (await res.json()) as { capabilities?: string[] };
    const ok = Boolean(info.capabilities?.includes("vision"));
    visionSupport.set(key, ok);
    return ok;
  } catch {
    return false;
  }
}

// --- Audio ---------------------------------------------------------------------------
const audioSupport = new Map<string, boolean>();

/** Whether a model can take audio. Ollama reports it; OpenAI-compatible servers are assumed able. */
export async function supportsAudio(p: Provider, model: string): Promise<boolean> {
  if (p.kind !== "ollama") return true;
  const key = `${p.baseUrl}|${model}`;
  if (audioSupport.has(key)) return audioSupport.get(key)!;
  try {
    const res = await fetch(`${p.baseUrl}/api/show`, { method: "POST", headers: headers(p), body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
    const info = (await res.json()) as { capabilities?: string[] };
    const ok = Boolean(info.capabilities?.includes("audio"));
    audioSupport.set(key, ok);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Speech to text through the OpenAI-style /audio/transcriptions endpoint, which
 * Ollama serves under /v1 for audio models (gemma4) and Whisper servers serve too.
 */
export async function transcribe(p: Provider, model: string, wav: Buffer, signal?: AbortSignal, hint?: string): Promise<string> {
  const url = p.kind === "ollama" ? `${p.baseUrl}/v1/audio/transcriptions` : `${p.baseUrl}/audio/transcriptions`;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");
  // Names and words to spell right ("Gamface", project names); servers that don't use it ignore it
  if (hint) form.append("prompt", hint.slice(0, 600));
  const h = headers(p);
  delete h["Content-Type"]; // fetch sets the multipart boundary
  const res = await fetch(url, { method: "POST", headers: h, body: form, signal: signal ?? AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`${p.name} transcription HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

// --- Ollama --------------------------------------------------------------------------
const thinkingSupport = new Map<string, boolean>();

export async function supportsThinking(p: Provider, model: string): Promise<boolean> {
  if (p.kind !== "ollama") return false;
  const key = `${p.baseUrl}|${model}`;
  if (thinkingSupport.has(key)) return thinkingSupport.get(key)!;
  try {
    const res = await fetch(`${p.baseUrl}/api/show`, { method: "POST", headers: headers(p), body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
    const info = (await res.json()) as { capabilities?: string[] };
    const ok = Boolean(info.capabilities?.includes("thinking"));
    thinkingSupport.set(key, ok);
    return ok;
  } catch {
    return false;
  }
}

async function ollamaBody(p: Provider, model: string, messages: ChatMessage[], opts: ChatOptions, stream: boolean) {
  const options: Record<string, unknown> = {};
  if (opts.numCtx) options.num_ctx = opts.numCtx;
  if (opts.temperature !== undefined) options.temperature = opts.temperature;
  if (opts.maxTokens) options.num_predict = opts.maxTokens;
  const body: Record<string, unknown> = { model, messages: toProviderMessages(p, messages), stream, keep_alive: opts.keepAlive ?? "30m", options };
  if (opts.json) body.format = "json";
  // Only models that support thinking accept the field; others reject it
  if (opts.think !== undefined && (await supportsThinking(p, model))) body.think = opts.think;
  return body;
}

// --- Chat calls ------------------------------------------------------------------------

/** Streams a reply token by token. Throws before the first token on connection/HTTP errors. */
export async function chatStream(
  p: Provider,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
  signal: AbortSignal,
  onToken: (text: string) => void,
): Promise<ChatResult> {
  const isOllama = p.kind === "ollama";
  const url = isOllama ? `${p.baseUrl}/api/chat` : `${p.baseUrl}/chat/completions`;
  const body = isOllama
    ? await ollamaBody(p, model, messages, opts, true)
    : {
        model,
        messages: toProviderMessages(p, messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      };
  const res = await fetch(url, { method: "POST", headers: headers(p), body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new Error(`${p.name} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: ChatResult = { text: "", promptTokens: 0, completionTokens: 0 };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (isOllama) {
        const f = JSON.parse(line) as { message?: { content?: string }; error?: string; done?: boolean; prompt_eval_count?: number; eval_count?: number };
        if (f.error) throw new Error(f.error);
        const piece = f.message?.content ?? "";
        if (piece) {
          out.text += piece;
          onToken(piece);
        }
        if (f.done) {
          out.promptTokens = f.prompt_eval_count ?? 0;
          out.completionTokens = f.eval_count ?? 0;
        }
      } else {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const f = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          error?: { message?: string };
        };
        if (f.error) throw new Error(f.error.message ?? "provider error");
        const piece = f.choices?.[0]?.delta?.content ?? "";
        if (piece) {
          out.text += piece;
          onToken(piece);
        }
        if (f.usage) {
          out.promptTokens = f.usage.prompt_tokens ?? 0;
          out.completionTokens = f.usage.completion_tokens ?? 0;
        }
      }
    }
  }
  return out;
}

/** One non-streamed call, for routing, planning and memory. With json:true the reply is parsed. */
export async function chatOnce(p: Provider, model: string, messages: ChatMessage[], opts: ChatOptions, timeoutMs = 120000): Promise<ChatResult & { json?: Record<string, unknown> }> {
  let res: Response;
  if (p.kind === "ollama") {
    res = await fetch(`${p.baseUrl}/api/chat`, {
      method: "POST",
      headers: headers(p),
      body: JSON.stringify(await ollamaBody(p, model, messages, opts, false)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const d = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    const text = d.message?.content ?? "";
    return { text, promptTokens: d.prompt_eval_count ?? 0, completionTokens: d.eval_count ?? 0, json: opts.json ? parseJsonLoose(text) : undefined };
  }
  const base = {
    model,
    messages: toProviderMessages(p, messages),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
  };
  const send = (body: unknown) =>
    fetch(`${p.baseUrl}/chat/completions`, { method: "POST", headers: headers(p), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  res = await send(opts.json ? { ...base, response_format: { type: "json_object" } } : base);
  // Some compatible endpoints reject response_format; the prompt already asks for JSON
  if (!res.ok && opts.json && res.status === 400) res = await send(base);
  if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const text = d.choices?.[0]?.message?.content ?? "";
  return { text, promptTokens: d.usage?.prompt_tokens ?? 0, completionTokens: d.usage?.completion_tokens ?? 0, json: opts.json ? parseJsonLoose(text) : undefined };
}

/** Models a provider offers, for the Team page's pickers. */
export async function listModels(p: Provider): Promise<string[]> {
  try {
    if (p.kind === "ollama") {
      const res = await fetch(`${p.baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
      const d = (await res.json()) as { models?: { name: string }[] };
      return (d.models ?? []).map((m) => m.name).sort();
    }
    const res = await fetch(`${p.baseUrl}/models`, { headers: headers(p), signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const d = (await res.json()) as { data?: { id: string }[] };
    return (d.data ?? []).map((m) => m.id.replace(/^models\//, "")).sort();
  } catch {
    return [];
  }
}

export async function checkProvider(p: Provider): Promise<{ ok: boolean; detail: string }> {
  if (p.apiKeyEnv && !process.env[p.apiKeyEnv]) return { ok: false, detail: `${p.apiKeyEnv} is not set` };
  const models = await listModels(p);
  return models.length ? { ok: true, detail: `${models.length} models` } : { ok: false, detail: "unreachable or no models" };
}
