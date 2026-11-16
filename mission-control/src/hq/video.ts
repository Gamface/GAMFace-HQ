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

/** What the Coder is told when its answer will be rendered. */
export function videoInstructions(pictures = 0): string {
  return (
    "\n\nVIDEO: Mission Control renders your answer with Remotion (4.x) into an MP4. Write the whole scene as ONE ```tsx code block:\n" +
    "- First line: // video: width=1920 height=1080 fps=30 seconds=10   (your choice; at most 1920×1080, 60 fps, " +
    `${VIDEO_MAX_SECONDS} seconds; width and height even)\n` +
    "- Export the scene as a named component: export const Video: React.FC<{ images: string[] }> = ({ images }) => { … }\n" +
    "- Animate with useCurrentFrame(), useVideoConfig(), interpolate() (with extrapolateRight: 'clamp'), spring(), <Sequence>, <AbsoluteFill>, <Img>. " +
    "Every frame must render from the frame number alone: no useEffect timers, no Math.random() (use random('seed') from remotion), no CSS transitions or animations.\n" +
    "- Packages you may import: react, remotion, @remotion/transitions, @remotion/shapes, @remotion/paths, @remotion/noise, @remotion/three, three, @react-three/fiber. Nothing else.\n" +
    "- There is NO internet while rendering: no web fonts, remote images, videos, audio or data. Use system fonts (sans-serif, serif, monospace) and draw with CSS, SVG or three.\n" +
    (pictures ? `- The user's ${pictures} attached picture(s) are in props.images (data URLs): use them with <Img src={images[0]} />.\n` : "") +
    "- After the code block, say in one or two sentences what the video shows."
  );
}

/** The last Remotion scene in an answer, with its size and length, or null. */
export function extractScene(answer: string): SceneSpec | null {
  const blocks = [...answer.matchAll(/```(?:tsx|jsx|ts|typescript|js|javascript)?[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const code = blocks.reverse().find((b) => /from\s+["']remotion["']/.test(b) && /\bVideo\b/.test(b));
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
  async render(spec: SceneSpec, props: Record<string, unknown>, onProgress: (p: RenderProgress) => void, signal?: AbortSignal): Promise<{ mp4: Buffer } | { error: string; fixable: boolean }> {
    let id: string;
    try {
      const r = await fetch(`${this.base}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...spec, props }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
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
