// Voiceovers and word timings for videos. The voice service (voice/, its own container
// with no internet) speaks narration with Kokoro and times every word with Whisper,
// so Remotion can show captions in sync. It also times the words of a recording you
// attach, and finds the beats of music in the asset dictionary.

import { createHash } from "node:crypto";

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Speech {
  wav: Buffer;
  seconds: number;
  words: Word[];
  voice: string;
}

/** Whether a request asks for a spoken voiceover. */
export function wantsVoice(text: string): boolean {
  return /\b(voice[- ]?overs?|vo\b|narrat\w*|voiced|spoken|speech|read (it |this |them )?(aloud|out)|talking|with (a |an )?(voice|narrator)|text[- ]to[- ]speech|tts)\b/i.test(text);
}

/** Whether a request asks for on-screen captions or subtitles. */
export function wantsCaptions(text: string): boolean {
  return /\b(captions?|captioned|subtitles?|subtitled|karaoke|words? on screen)\b/i.test(text);
}

/** Whether the user wants their attached recording used as the video's soundtrack. */
export function wantsOwnAudio(text: string): boolean {
  return /\b(use|using|with|over|put|caption(ed|s)?|subtitle(d|s)?|add)\b[^.?!]{0,40}\b(my|this|the|attached)\s+(attached\s+)?(audio|recording|voice ?(memo|note|clip)?|clip|podcast|narration|soundtrack)\b/i.test(text);
}

/** The narration the Coder wrote, from a ```narration block, or null. */
export function extractNarration(answer: string): string | null {
  const blocks = [...answer.matchAll(/```narration[^\n]*\n([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter(Boolean);
  const text = blocks.pop();
  if (!text) return null;
  // Stage directions don't get read out
  return (
    text
      .split("\n")
      .map((l) => l.replace(/^\s*(\[[^\]]*\]|\([^)]*\))\s*/g, "").replace(/^\s*(narrator|voice ?over|vo)\s*:\s*/i, ""))
      .join("\n")
      .trim() || null
  );
}

/** The voice and speed from a scene's header: // video: … voice=am_adam speed=1.1 */
export function sceneVoice(code: string, fallback: string): { voice: string; speed: number } {
  const head = /\/\/\s*video:([^\n]*)/i.exec(code)?.[1] ?? "";
  const voice = /voice\s*=\s*([a-z]{2}_[a-z0-9]+)/i.exec(head)?.[1]?.toLowerCase() ?? fallback;
  const speed = Number(/speed\s*=\s*([\d.]+)/i.exec(head)?.[1]);
  return { voice, speed: Number.isFinite(speed) && speed > 0 ? Math.min(1.6, Math.max(0.6, speed)) : 1 };
}

/** Roughly how many words fit in a voiceover of this length (Kokoro speaks about 2.6 words a second). */
export const wordsFor = (seconds: number) => Math.max(8, Math.floor(seconds * 2.4));

// Kokoro v1.0's voices, for the dashboard (the service reports what it really has)
export const KNOWN_VOICES: Record<string, string> = {
  af_heart: "Heart (US, female)",
  af_bella: "Bella (US, female)",
  af_nicole: "Nicole (US, female, soft)",
  af_sarah: "Sarah (US, female)",
  af_sky: "Sky (US, female)",
  am_adam: "Adam (US, male)",
  am_michael: "Michael (US, male)",
  am_fenrir: "Fenrir (US, male)",
  am_puck: "Puck (US, male)",
  bf_emma: "Emma (UK, female)",
  bf_isabella: "Isabella (UK, female)",
  bm_george: "George (UK, male)",
  bm_lewis: "Lewis (UK, male)",
};

type Health = { ok: boolean; ready: boolean; voices: string[]; whisper: string | null; error: string | null };

/** Talks to the voice service. */
export class VoiceClient {
  private cache = new Map<string, Speech>();

  constructor(private base: string) {}

  async health(): Promise<Health | null> {
    try {
      const r = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(4000) });
      return (await r.json()) as Health;
    } catch {
      return null;
    }
  }

  private async post<T>(route: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T | { error: string }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const r = await fetch(`${this.base}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const out = (await r.json()) as T & { error?: string };
      if (!r.ok) return { error: out.error ?? `The voice service said ${r.status}` };
      return out;
    } catch (e) {
      if (signal?.aborted) throw e;
      return { error: timeout.aborted ? "The voice service took too long" : `The voice service isn't reachable (${e instanceof Error ? e.message : String(e)}). Is the voice container running?` };
    }
  }

  /** Speaks narration. The same text and voice are spoken once (a fixed scene re-renders with the same audio). */
  async speak(text: string, voice: string, speed = 1, signal?: AbortSignal): Promise<Speech | { error: string }> {
    const key = createHash("sha256").update(`${voice}|${speed}|${text}`).digest("hex");
    const hit = this.cache.get(key);
    if (hit) return hit;
    // About a second of work per sentence on a CPU
    const out = await this.post<{ audio: string; seconds: number; words: Word[]; voice: string }>("/speak", { text, voice, speed }, 10 * 60_000, signal);
    if ("error" in out) return out;
    const speech = { wav: Buffer.from(out.audio, "base64"), seconds: out.seconds, words: out.words ?? [], voice: out.voice };
    this.cache.set(key, speech);
    while (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
    return speech;
  }

  /** Word timings for a recording. With text (a transcript), captions use its spelling. */
  async words(audio: Buffer, text?: string, signal?: AbortSignal): Promise<{ words: Word[]; seconds: number; text: string } | { error: string }> {
    return this.post("/words", { audio: audio.toString("base64"), text }, 10 * 60_000, signal);
  }

  /** Speech to text with Whisper. `prompt` lists names to spell right. */
  async transcribe(audio: Buffer, prompt?: string, signal?: AbortSignal): Promise<{ text: string; seconds: number; model: string } | { error: string }> {
    return this.post("/transcribe", { audio: audio.toString("base64"), prompt: prompt?.slice(0, 600) }, 5 * 60_000, signal);
  }

  /** The tempo and beat times of a music track. */
  async beats(audio: Buffer): Promise<{ tempo: number | null; beats: number[]; seconds: number } | { error: string }> {
    return this.post("/beats", { audio: audio.toString("base64") }, 5 * 60_000);
  }
}
