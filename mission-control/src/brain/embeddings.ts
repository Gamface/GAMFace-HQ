// Embedding client for the local Ollama server (memory search). Pull the
// model once:  ollama pull nomic-embed-text

const env = process.env;

export const EMBED_MODEL = env.EMBED_MODEL ?? "nomic-embed-text";
export const EMBED_DIMS = Number(env.EMBED_DIMS ?? 768);
// Same Ollama as the agents unless EMBED_OLLAMA_URL says otherwise
const OLLAMA_URL = (env.EMBED_OLLAMA_URL || env.OLLAMA_BASE_URL || "http://127.0.0.1:11435").replace(/\/+$/, "");
// Long enough for Ollama to load the model cold; short enough not to stall agents.
const EMBED_TIMEOUT_MS = Number(env.EMBED_TIMEOUT_MS ?? 15_000);
// nomic-embed-text is trained with task prefixes; other models get raw text.
const USE_NOMIC_PREFIXES = EMBED_MODEL.startsWith("nomic-embed");

export type EmbedKind = "query" | "document";

/** Embed one text. Throws on timeout, HTTP error or wrong vector size. */
export async function embed(text: string, kind: EmbedKind): Promise<number[]> {
  const input = USE_NOMIC_PREFIXES
    ? `${kind === "query" ? "search_query" : "search_document"}: ${text}`
    : text;
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { embeddings?: number[][] };
  const vec = data.embeddings?.[0];
  if (!vec || vec.length !== EMBED_DIMS) {
    throw new Error(`Embedding has ${vec?.length ?? 0} dims; schema expects ${EMBED_DIMS}`);
  }
  return vec;
}

/** Like embed(), but returns null instead of throwing (logged), so callers can degrade. */
export async function tryEmbed(text: string, kind: EmbedKind): Promise<number[] | null> {
  try {
    return await embed(text, kind);
  } catch (err) {
    console.warn(`[agent-os] embedding unavailable: ${(err as Error).message}`);
    return null;
  }
}

/** pgvector text literal, or null when there is no vector. */
export const vectorLiteral = (v: number[] | null) => (v ? `[${v.join(",")}]` : null);
