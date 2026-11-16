// Tests for videos with Remotion.   npm test
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Files } from "../src/hq/pdf";
import { VideoClient, extractScene, videoInstructions, wantsVideo } from "../src/hq/video";

const scene = (head = "// video: width=1080 height=1920 fps=24 seconds=8") =>
  "```tsx\n" + head + "\nimport React from 'react';\nimport { AbsoluteFill, useCurrentFrame } from 'remotion';\nexport const Video: React.FC = () => <AbsoluteFill>{useCurrentFrame()}</AbsoluteFill>;\n```";

test("video requests are recognised; finding or watching one is not making one", () => {
  for (const t of ["Make a 20-second intro video for my channel", "create an animated logo for GAMFace", "render a countdown", "Turn these notes into an explainer video", "use remotion to make a chart race"])
    assert.equal(wantsVideo(t), true, t);
  for (const t of ["find a video about sourdough", "summarize this YouTube video", "what's the best video editor?", "make a PDF report", "watch the intro video and tell me what it says"])
    assert.equal(wantsVideo(t), false, t);
});

test("the scene's size, speed and length come from its first line, within limits", () => {
  const s = extractScene(`Here you go:\n${scene()}\nIt shows a counter.`)!;
  assert.deepEqual([s.width, s.height, s.fps, s.durationInFrames], [1080, 1920, 24, 192]);
  assert.match(s.code, /export const Video/);
  const d = extractScene(scene("// a scene"))!;
  assert.deepEqual([d.width, d.height, d.fps, d.durationInFrames], [1920, 1080, 30, 300], "defaults");
  const big = extractScene(scene("// video: width=3840 height=2160 fps=120 seconds=600"))!;
  assert.ok(big.width * big.height <= 1920 * 1080 && big.width % 2 === 0 && big.height % 2 === 0);
  assert.equal(big.fps, 60);
  assert.equal(big.durationInFrames, 60 * 60, "at most 60 seconds");
  // The last scene wins (a fixed version after a broken one); other code blocks are ignored
  const two = extractScene(`${scene("// video: seconds=3")}\n\n\`\`\`bash\nnpm i\n\`\`\`\n\n${scene("// video: seconds=5")}`)!;
  assert.equal(two.durationInFrames, 150);
  assert.equal(extractScene("```tsx\nconst x = 1;\n```"), null);
});

test("the Coder is told the rules: one file, Video export, no internet, which packages", () => {
  const t = videoInstructions(2);
  assert.match(t, /export const Video/);
  assert.match(t, /NO internet/);
  assert.match(t, /@remotion\/transitions/);
  assert.match(t, /props\.images/);
  assert.ok(!videoInstructions(0).includes("props.images"));
});

test("talking to the video service: progress, the MP4, errors to fix, and a service that's down", async () => {
  const jobs = new Map<string, { n: number; fail?: string }>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/render") {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (!/Video/.test(body.code)) return res.writeHead(400).end(JSON.stringify({ error: "The scene must export a component named Video" }));
        const id = `job${jobs.size}`;
        jobs.set(id, { n: 0, fail: body.code.includes("BROKEN") ? "Cannot read properties of undefined (reading 'map')" : undefined });
        return res.writeHead(202).end(JSON.stringify({ id, props: body.props }));
      }
      const m = /^\/jobs\/(job\d+)(\/video)?$/.exec(req.url ?? "");
      const j = m && jobs.get(m[1]);
      if (!j) return res.writeHead(404).end("{}");
      if (m![2]) return res.writeHead(200, { "Content-Type": "video/mp4" }).end(Buffer.from("....ftypisom-fake"));
      j.n++;
      if (j.fail && j.n > 1) return res.end(JSON.stringify({ status: "error", progress: 50, error: j.fail }));
      return res.end(JSON.stringify(j.n < 3 ? { status: j.n === 1 ? "bundling" : "rendering", progress: j.n * 30 } : { status: "done", progress: 100 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const client = new VideoClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    const spec = extractScene(scene())!;
    const seen: string[] = [];
    const ok = await client.render(spec, { images: [] }, (p) => seen.push(p.stage));
    assert.ok("mp4" in ok && ok.mp4.toString().includes("ftyp"));
    assert.deepEqual(seen, ["bundling", "rendering"]);
    const broken = await client.render({ ...spec, code: spec.code + "\n// BROKEN" }, {}, () => {});
    assert.deepEqual(broken, { error: "Cannot read properties of undefined (reading 'map')", fixable: true });
    const bad = await client.render({ ...spec, code: "nothing here at all" }, {}, () => {});
    assert.deepEqual(bad, { error: "The scene must export a component named Video", fixable: true });
  } finally {
    server.close();
  }
  const down = await new VideoClient("http://127.0.0.1:1").render(extractScene(scene())!, {}, () => {});
  assert.ok("error" in down && !down.fixable && /isn't reachable/.test(down.error));
  assert.equal(await new VideoClient("http://127.0.0.1:1").health(), null);
});

test("rendered videos are saved as .mp4 files", () => {
  const f = new Files(mkdtempSync(path.join(tmpdir(), "vid-")));
  const saved = f.save("My Channel Intro!", Buffer.from("....ftypisom"), "mp4");
  assert.match(saved.name, /^my-channel-intro-[a-f0-9]{8}\.mp4$/);
  assert.ok(f.read(saved.name));
});
