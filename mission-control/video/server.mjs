// Mission Control video service: renders Remotion scenes to MP4.
//
//   POST /render  { code, width, height, fps, durationInFrames, props?, files? }  → { id }
//   GET  /jobs/:id                → { status, progress, stage, error? }
//   GET  /jobs/:id/video          → the MP4 (once done)
//   GET  /health                  → { ok, remotion }
//
// Each job gets its own small Remotion project (index.ts → Root.tsx → Video.tsx,
// where Video.tsx is the scene the agent wrote and mc.tsx is Mission Control's kit of
// captions, brand pieces and templates). files ([{ name, base64 }]: the voiceover,
// music, logos and clips from the asset dictionary) go in its public/ folder, where
// scenes reach them with staticFile(). The project is bundled with @remotion/bundler and
// rendered with @remotion/renderer. Node never runs the scene code; only headless
// Chrome does. The container has no internet and no access to your files or keys.
// One render at a time; finished videos are kept for an hour.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";

const PORT = Number(process.env.PORT) || 3020;
const MAX_SECONDS = Number(process.env.VIDEO_MAX_SECONDS) || 60;
const MAX_PIXELS = 1920 * 1080;
const RENDER_TIMEOUT_MS = (Number(process.env.VIDEO_TIMEOUT_MIN) || 15) * 60_000;
const CONCURRENCY = process.env.VIDEO_CONCURRENCY ? Number(process.env.VIDEO_CONCURRENCY) : null;
// No GPU in the container: SwiftShader-ANGLE is Remotion's software path that also runs WebGL (3D)
const GL = process.env.VIDEO_GL || "swangle";
// Remotion serves each bundle to its Chrome on a local port (3000 by default); keep it off 3000
const BUNDLE_PORT = Number(process.env.VIDEO_BUNDLE_PORT) || 3100;
const JOBS_DIR = path.resolve(process.env.JOBS_DIR || "/app/jobs");
const KEEP_MS = 60 * 60_000;
const MAX_BODY = 160 * 1024 * 1024;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,90}\.(png|jpe?g|webp|gif|svg|mp4|webm|mov|wav|mp3|m4a|ogg|aac|ttf|otf|woff2?)$/i;
const KIT = readFileSync(new URL("./mc.tsx", import.meta.url), "utf8");

mkdirSync(JOBS_DIR, { recursive: true });
const REMOTION_VERSION = JSON.parse(readFileSync(new URL("./node_modules/remotion/package.json", import.meta.url), "utf8")).version;

/** @type {Map<string, {id: string, status: "queued"|"bundling"|"rendering"|"done"|"error", progress: number, error?: string, file?: string, createdAt: number, spec: any, cancel?: () => void}>} */
const jobs = new Map();
const queue = [];
let busy = false;

function check(spec) {
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : NaN);
  const width = n(spec.width) || 1920;
  const height = n(spec.height) || 1080;
  const fps = n(spec.fps) || 30;
  const durationInFrames = n(spec.durationInFrames) || fps * 10;
  if (typeof spec.code !== "string" || spec.code.length < 20) return { error: "No scene code" };
  if (spec.code.length > 200_000) return { error: "The scene code is too long" };
  if (!/export\s+(const|function)\s+Video\b|export\s*\{[^}]*\bVideo\b/.test(spec.code)) return { error: "The scene must export a component named Video" };
  if (width < 16 || height < 16 || width % 2 || height % 2 || width * height > MAX_PIXELS) return { error: `Size must be even and at most 1920×1080 (got ${width}×${height})` };
  if (fps < 1 || fps > 60) return { error: "fps must be 1–60" };
  if (durationInFrames < 1 || durationInFrames / fps > MAX_SECONDS) return { error: `Videos can be at most ${MAX_SECONDS} seconds` };
  const props = spec.props && typeof spec.props === "object" ? { ...spec.props } : {};
  const files = [];
  for (const f of Array.isArray(spec.files) ? spec.files : []) {
    if (!f || typeof f.name !== "string" || !FILE_NAME.test(f.name) || typeof f.base64 !== "string") return { error: `Bad file: ${String(f?.name).slice(0, 80)}` };
    files.push({ name: f.name, data: Buffer.from(f.base64, "base64") });
  }
  if (files.length > 24) return { error: "Too many files" };
  // Automatic captions, unless the scene draws its own
  if (props.captions && typeof props.captions === "object" && props.captions.auto && /\b(Captions|Social)\b/.test(spec.code)) props.captions = { ...props.captions, auto: false };
  return { code: spec.code, width, height, fps, durationInFrames, props, files };
}

function project(dir, spec) {
  const src = path.join(dir, "src");
  mkdirSync(src, { recursive: true });
  const pub = path.join(dir, "public");
  mkdirSync(pub, { recursive: true });
  for (const f of spec.files) writeFileSync(path.join(pub, f.name), f.data);
  writeFileSync(path.join(src, "Video.tsx"), spec.code);
  writeFileSync(path.join(src, "mc.tsx"), KIT);
  writeFileSync(
    path.join(src, "Root.tsx"),
    `import React from "react";
import { Composition } from "remotion";
import { Video } from "./Video";
import { DEFAULT_PROPS, withMC } from "./mc";

const Main = withMC(Video as React.ComponentType<any>);

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Main"
    component={Main as React.FC<any>}
    durationInFrames={${spec.durationInFrames}}
    fps={${spec.fps}}
    width={${spec.width}}
    height={${spec.height}}
    defaultProps={DEFAULT_PROPS as any}
  />
);
`,
  );
  writeFileSync(path.join(src, "index.ts"), `import { registerRoot } from "remotion";\nimport { RemotionRoot } from "./Root";\nregisterRoot(RemotionRoot);\n`);
  return { entryPoint: path.join(src, "index.ts"), publicDir: pub };
}

/** Remotion's errors can be long; keep the part that helps fix the scene. */
function shortError(e) {
  const msg = (e && (e.stack || e.message)) || String(e);
  return msg
    .split("\n")
    .filter((l) => !/node_modules|at async|internal\/|server\.mjs|\(node:|at IncomingMessage|at process\./.test(l))
    .slice(0, 12)
    .join("\n")
    .replace(/^(Error: )+/, "")
    .slice(0, 3000);
}

async function run(job) {
  const dir = path.join(JOBS_DIR, job.id);
  const timer = setTimeout(() => job.cancel?.(), RENDER_TIMEOUT_MS);
  try {
    job.status = "bundling";
    const { entryPoint, publicDir } = project(dir, job.spec);
    job.spec.files = [];
    const serveUrl = await bundle({ entryPoint, publicDir, outDir: path.join(dir, "bundle"), onProgress: (p) => (job.progress = Math.round(p * 0.2)) });
    job.status = "rendering";
    const inputProps = job.spec.props;
    const composition = await selectComposition({ serveUrl, id: "Main", inputProps, chromiumOptions: { gl: GL }, port: BUNDLE_PORT });
    const { cancelSignal, cancel } = makeCancelSignal();
    job.cancel = cancel;
    const file = path.join(dir, "video.mp4");
    await renderMedia({
      composition,
      serveUrl,
      port: BUNDLE_PORT,
      codec: "h264",
      outputLocation: file,
      inputProps,
      cancelSignal,
      concurrency: CONCURRENCY,
      chromiumOptions: { gl: GL },
      onProgress: ({ progress }) => (job.progress = 20 + Math.round(progress * 80)),
    });
    job.file = file;
    job.progress = 100;
    job.status = "done";
    rmSync(path.join(dir, "bundle"), { recursive: true, force: true });
    rmSync(path.join(dir, "public"), { recursive: true, force: true });
  } catch (e) {
    job.status = "error";
    job.error = /cancel/i.test(String(e?.message)) ? `The render took longer than ${RENDER_TIMEOUT_MS / 60000} minutes and was stopped` : shortError(e);
  } finally {
    clearTimeout(timer);
    job.cancel = undefined;
  }
}

async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    await run(job);
  } finally {
    busy = false;
    void pump();
  }
}

// Old jobs go after an hour
setInterval(() => {
  for (const [id, j] of jobs) {
    if (Date.now() - j.createdAt > KEEP_MS && j.status !== "rendering" && j.status !== "bundling") {
      rmSync(path.join(JOBS_DIR, id), { recursive: true, force: true });
      jobs.delete(id);
    }
  }
}, 5 * 60_000).unref();

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, remotion: REMOTION_VERSION, kit: true, busy, queued: queue.length });
  if (req.method === "POST" && url.pathname === "/render") {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return send(res, 413, { error: "Request too large" });
      let spec;
      try {
        spec = check(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        return send(res, 400, { error: "Invalid JSON" });
      }
      if (spec.error) return send(res, 400, spec);
      if (queue.length >= 5) return send(res, 429, { error: "Too many videos waiting" });
      const job = { id: randomUUID(), status: "queued", progress: 0, createdAt: Date.now(), spec };
      jobs.set(job.id, job);
      queue.push(job);
      void pump();
      send(res, 202, { id: job.id });
    });
    return;
  }
  const m = /^\/jobs\/([a-f0-9-]{36})(\/video)?$/.exec(url.pathname);
  if (req.method === "GET" && m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: "No such job" });
    if (!m[2]) return send(res, 200, { status: job.status, progress: job.progress, error: job.error, queued: queue.indexOf(job) + 1 || undefined });
    if (job.status !== "done" || !job.file || !existsSync(job.file)) return send(res, 409, { error: "Not ready" });
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(statSync(job.file).size) });
    res.end(readFileSync(job.file));
    return;
  }
  if (req.method === "DELETE" && m && !m[2]) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: "No such job" });
    job.cancel?.();
    const i = queue.indexOf(job);
    if (i >= 0) {
      queue.splice(i, 1);
      job.status = "error";
      job.error = "Canceled";
    }
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Video service (Remotion ${REMOTION_VERSION}) on port ${PORT}, at most ${MAX_SECONDS}s per video`));
