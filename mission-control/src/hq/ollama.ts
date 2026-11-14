// Non-streaming Ollama calls for the small structured jobs: routing,
// delegation planning and memory extraction.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type JsonChat = (model: string, messages: ChatMessage[]) => Promise<Record<string, unknown>>;

export function makeJsonChat(baseUrl: string, keepAlive = "30m", timeoutMs = 120000): JsonChat {
  return async (model, messages) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, format: "json", keep_alive: keepAlive, options: { temperature: 0.1 } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return parseJsonLoose(data.message?.content ?? "");
  };
}

export function parseJsonLoose(text: string): Record<string, unknown> {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  for (const candidate of [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return {};
}
