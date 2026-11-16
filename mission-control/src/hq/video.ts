// Videos with Remotion. When a request asks for a video, the Coder writes a Remotion
// scene (one React/TypeScript file); the harness sends it to the video service
// (video/server.mjs, its own container with no internet), which renders it with real
// Remotion and returns an MP4. A failed render goes back to the Coder to fix.

export interface SceneSpec {
  code: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export const VIDEO_MAX_SECONDS = Number(process.env.VIDEO_MAX_SECONDS) || 60;

/** Whether a request asks for a video to be made (not watched or found). */
export function wantsVideo(text: string): boolean {
  if (/\bremotion\b/i.test(text)) return true;
  const noun = /\b(video|animation|animated (intro|logo|title|text|chart|explainer)|intro|outro|reel|explainer|motion graphics?|lower third|title sequence|countdown)s?\b/i;
  const verb = /\b(make|create|render|produce|generate|build|design|animate|edit|turn\b[^.?!]{0,40}\binto)\b/i;
  if (!noun.test(text) || !verb.test(text)) return false;
  // Finding or summarizing a video is a browsing job
  if (/\b(find|search|watch|summari[sz]e|transcribe|download|look up)\b[^.?!]{0,40}\bvideos?\b/i.test(text)) return false;
  return true;
}

export interface VideoOptions {
  pictures?: number;
  /** Write a ```narration block: Kokoro speaks it and the video gets its length */
  voice?: boolean;
  /** Show word-by-word captions */
  captions?: boolean;
  /** The user's recording is the soundtrack: its length and transcript */
  recording?: { seconds: number; text: string } | null;
  /** The asset dictionary's block (assetBlock) */
  assets?: string;
  /** Prefer vertical 1080×1920 */
  vertical?: boolean;
}

/** Whether a request wants a vertical (phone) video. */
export const wantsVertical = (text: string) => /\b(vertical|portrait|9:16|tiktok|reels?|shorts|instagram stor(y|ies)|phone[- ]sized)\b/i.test(text);

/** What the Coder is told when its answer will be rendered. */
export function videoInstructions(opts: number | VideoOptions = 0): string {
  const o: VideoOptions = typeof opts === "number" ? { pictures: opts } : opts;
  const pictures = o.pictures ?? 0;
  const size = o.vertical ? "width=1080 height=1920" : "width=1920 height=1080";
  const lines = [
    "\n\nVIDEO: Mission Control renders your answer with Remotion (4.x) into an MP4. Write the whole scene as ONE ```tsx code block:",
    `- First line: // video: ${size} fps=30 seconds=10${o.voice ? " voice=af_heart" : ""}   (your choice; at most 1920×1080 pixels (portrait is fine), 60 fps, ${VIDEO_MAX_SECONDS} seconds; width and height even)`,
    "- Export the scene as a named component: export const Video: React.FC<{ images: string[] }> = ({ images }) => { … }",
    "- EASIEST AND MOST RELIABLE: fill in a ready-made template from Mission Control's kit, which handles timing, layout, brand colours and animation and fits any length:",
    '    import { Promo } from "./mc";',
    '    export const Video = () => <Promo title="…" subtitle="…" points={["…", "…", "…"]} cta="…" media={["asset-id or images[0]"]} />;',
    "  Templates: Promo (title, subtitle?, points?, cta?, media?) · Explainer (title, steps: {title, text?}[], media?) · Social (hook, lines?, media?, cta?; for vertical shorts, best with a voiceover) · Quote (quote, author?, media?).",
    "- Or build your own from the kit's pieces (all from \"./mc\"): <Background variant=\"gradient|grid|dots\" />, <TitleCard title subtitle? />, <KineticText text />, <BulletList items title? />, <LowerThird name role? />, " +
      "<Media id|src dim? /> (picture or clip filling the frame), <Logo size? />, <EndCard text? cta? />, <Section from durationInFrames> (a Sequence that fades), <Captions style? position? />; " +
      "hooks useMC() (words, brand, assets), useBeat() → { pulse }, useSpokenWord(), useEnter(delay) → { opacity, y, scale }; cueFrame(word, fps) → the frame a word is spoken. Put TitleCard, KineticText, BulletList, LowerThird and EndCard inside a <Sequence>/<Section>.",
    "- With plain Remotion: useCurrentFrame(), useVideoConfig(), interpolate() (with extrapolateRight: 'clamp'), spring(), <Sequence>, <AbsoluteFill>, <Img>. " +
      "Every frame must render from the frame number alone: no useEffect timers, no Math.random() (use random('seed') from remotion), no CSS transitions or animations.",
    "- Packages you may import: react, remotion, ./mc, @remotion/transitions, @remotion/shapes, @remotion/paths, @remotion/noise, @remotion/three, three, @react-three/fiber. Nothing else.",
    "- There is NO internet while rendering: no web fonts, remote images, videos, audio or data. Use system fonts (sans-serif, serif, monospace), the kit, CSS, SVG or three.",
  ];
  if (pictures) lines.push(`- The user's ${pictures} attached picture(s) are in props.images (data URLs): use them with <Img src={images[0]} /> or media={[images[0]]}.`);
  if (o.assets) lines.push(o.assets);
  if (o.recording) {
    lines.push(
      `- SOUNDTRACK: the user's recording (${Math.round(o.recording.seconds)} s) plays automatically and the video lasts as long as it does; don't add audio. ` +
        `Its words are timed in useMC().words, so visuals can follow what's said (cueFrame("word", fps)). ` +
        (o.recording.text ? `What it says: "${o.recording.text.slice(0, 1500)}"` : "What it says is in the transcript above."),
    );
  } else if (o.voice) {
    lines.push(
      "- VOICEOVER: after the code block, write what the narrator says in a ```narration block (plain spoken sentences; no stage directions, no speaker names). " +
        "Mission Control speaks it with Kokoro, plays it automatically and makes the video at least as long as the narration (about 2.5 words a second), so set seconds to match. " +
        "Don't add audio yourself. Narration words are timed in useMC().words; cueFrame(\"word\", fps) gives the frame a word is spoken, so visuals can land on it. " +
        "Pick the voice in the first line with voice=: af_heart, af_bella, af_sarah, am_adam, am_michael (US); bf_emma, bm_george (UK).",
    );
  }
  if (o.captions && (o.voice || o.recording)) lines.push("- CAPTIONS: word-by-word captions are added automatically at the bottom (the Social template draws its own). Keep the bottom fifth of the frame clear, or place <Captions position=\"top\" /> yourself.");
  else if (o.captions) lines.push("- CAPTIONS: there's no voiceover, so show the text on screen yourself (KineticText or BulletList).");
  lines.push("- After the code block" + (o.voice && !o.recording ? " (and the narration)" : "") + ", say in one or two sentences what the video shows.");
  return lines.join("\n");
}

/** The last Remotion scene in an answer, with its size and length, or null. */
export function extractScene(answer: string): SceneSpec | null {
  const blocks = [...answer.matchAll(/```(?:tsx|jsx|ts|typescript|js|javascript)?[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const code = blocks.reverse().find((b) => /from\s+["'](remotion|\.\/mc)["']/.test(b) && /\bVideo\b/.test(b));
  if (!code) return null;
  const head = /\/\/\s*video:([^\n]*)/i.exec(code)?.[1] ?? "";
  const num = (k: string) => Number(new RegExp(`${k}\\s*=\\s*([\\d.]+)`, "i").exec(head)?.[1]);
  const even = (n: number, d: number, max: number) => {
    const v = Number.isFinite(n) && n > 0 ? Math.round(n) : d;
    return Math.min(max, v - (v % 2));
  };
  let width = even(num("width"), 1920, 1920);
  let height = even(num("height"), 1080, 1920);
  // Keep within 1920×1080 worth of pixels (portrait is fine)
  if (width * height > 1920 * 1080) {
    const scale = Math.sqrt((1920 * 1080) / (width * height));
    width = even(width * scale, 1920, 1920);
    height = even(height * scale, 1080, 1920);
  }
  const fps = Math.min(60, Math.max(1, Math.round(num("fps")) || 30));
  const seconds = Math.min(VIDEO_MAX_SECONDS, Math.max(1, num("seconds") || 10));
  return { code, width, height, fps, durationInFrames: Math.round(seconds * fps) };
}

export interface RenderProgress {
  stage: "queued" | "bundling" | "rendering";
  progress: number;
}

/** Talks to the video service. */
export class VideoClient {
  constructor(private base: string) {}

  async health(): Promise<{ ok: boolean; remotion?: string } | null> {
    try {
      const r = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(4000) });
      return (await r.json()) as { ok: boolean; remotion?: string };
    } catch {
      return null;
    }
  }

  /** Renders a scene. Resolves with the MP4, or the error to show the Coder. */
  async render(
    spec: SceneSpec,
    props: Record<string, unknown>,
    onProgress: (p: RenderProgress) => void,
    signal?: AbortSignal,
    /** For the renderer's public folder: the voiceover, music and assets */
    files: { name: string; base64: string }[] = [],
  ): Promise<{ mp4: Buffer } | { error: string; fixable: boolean }> {
    let id: string;
    try {
      const r = await fetch(`${this.base}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...spec, props, files }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      });
      const body = (await r.json()) as { id?: string; error?: string };
      if (!r.ok || !body.id) return { error: body.error ?? `The video service said ${r.status}`, fixable: r.status === 400 };
      id = body.id;
    } catch (e) {
      if (signal?.aborted) throw e;
      return { error: `The video service isn't reachable (${e instanceof Error ? e.message : String(e)}). Is the video container running?`, fixable: false };
    }
    const cancel = () => void fetch(`${this.base}/jobs/${id}`, { method: "DELETE" }).catch(() => {});
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) throw new Error("aborted");
        await new Promise((r) => setTimeout(r, 1000));
        const r = await fetch(`${this.base}/jobs/${id}`, { signal: AbortSignal.timeout(10_000) });
        const st = (await r.json()) as { status: string; progress: number; error?: string };
        if (st.status === "error") return { error: st.error ?? "The render failed", fixable: !/took longer|Canceled/.test(st.error ?? "") };
        if (st.status === "done") {
          const v = await fetch(`${this.base}/jobs/${id}/video`, { signal: AbortSignal.timeout(60_000) });
          if (!v.ok) return { error: "The finished video couldn't be fetched", fixable: false };
          return { mp4: Buffer.from(await v.arrayBuffer()) };
        }
        onProgress({ stage: st.status as RenderProgress["stage"], progress: st.progress ?? 0 });
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
}
