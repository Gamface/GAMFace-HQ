// Tests for picture uploads and the vision agent.   npm test
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ModelGateway } from "../src/hq/gateway";
import { ModelRegistry } from "../src/hq/models";
import { Notices } from "../src/hq/notices";
import { TaskStore } from "../src/hq/taskstore";
import { MAX_IMAGE_BYTES, Uploads, sniffImage } from "../src/hq/uploads";

// A real 1x1 PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("uploads accept real pictures only, stored by content hash", () => {
  const up = new Uploads(mkdtempSync(path.join(tmpdir(), "up-")));
  const ok = up.save(`data:image/png;base64,${PNG_B64}`);
  assert.ok(!("error" in ok));
  if ("error" in ok) return;
  assert.match(ok.id, /^[a-f0-9]{64}\.png$/);
  assert.equal(ok.type, "image/png");
  assert.equal(up.save(PNG_B64).toString(), ok.toString()); // same bytes, same id
  assert.equal((up.save(PNG_B64) as { id: string }).id, ok.id);
  assert.equal(up.base64(ok.id), PNG_B64);
  // Not a picture, even if it claims to be
  assert.match((up.save(`data:image/png;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`) as { error: string }).error, /Only PNG, JPEG, GIF and WebP/);
  assert.match((up.save("not base64 !!") as { error: string }).error, /base64/);
  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 10);
  huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.match((up.save(huge.toString("base64")) as { error: string }).error, /at most/);
  // Ids can't walk out of the uploads folder
  assert.equal(up.read("../../etc/passwd"), null);
  assert.equal(up.read(`${"a".repeat(64)}.png`), null);
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(sniffImage(Buffer.from("GIF89a....")), "gif");
  assert.equal(sniffImage(Buffer.from("RIFF....WEBPVP8 ")), "webp");
});

interface Fake {
  server: Server;
  url: string;
  bodies: Record<string, unknown>[];
}

/** One fake server that speaks both Ollama (/api/*) and OpenAI (/v1/*); "nolook" models have no vision. */
function fakeServer(): Promise<Fake> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/api/show") {
        return res.end(JSON.stringify({ capabilities: String(body.model).includes("nolook") ? ["completion"] : ["completion", "vision"] }));
      }
      bodies.push(body);
      if (req.url === "/api/chat") {
        res.end(`${JSON.stringify({ message: { content: "a cat" }, done: false })}\n${JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 2 })}\n`);
      } else {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "a dog" } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies })));
}

let fake: Fake;
let models: ModelRegistry;
let gateway: ModelGateway;
let notices: Notices;

before(async () => {
  fake = await fakeServer();
  process.env.OLLAMA_BASE_URL = fake.url;
  process.env.VISION_FAKE_KEY = "k";
  const store = new TaskStore(":memory:");
  models = new ModelRegistry(store, { model: "qwen3:14b", fastModel: "qwen3:4b", visionModel: "qwen3.5:latest", numCtx: 8192, think: false });
  notices = new Notices(store);
  gateway = new ModelGateway(models, store, notices);
  assert.equal(
    models.update({ customProviders: [{ id: "cloudy", name: "Cloud", baseUrl: `${fake.url}/v1`, apiKeyEnv: "VISION_FAKE_KEY" }] }),
    null,
  );
});

after(() => fake.server.close());

const withPicture = () => [{ role: "user" as const, content: "what is this?", images: [PNG_B64] }];
const signal = () => new AbortController().signal;

test("the vision agent defaults to the local vision model", () => {
  assert.equal(models.resolve("vision").ref, "ollama/qwen3.5:latest");
  assert.equal(models.localFor("vision").ref, "ollama/qwen3.5:latest");
});

test("Ollama gets pictures on the message; answers about pictures count as private", async () => {
  fake.bodies.length = 0;
  const out = await gateway.stream("vision", withPicture(), signal(), () => {}, () => {});
  assert.equal(out.text, "a cat");
  assert.equal(out.sawPrivate, true);
  const msg = (fake.bodies[0].messages as { images?: string[] }[])[0];
  assert.deepEqual(msg.images, [PNG_B64]);
});

test("pictures don't go to a cloud model unless the agent may send private context", async () => {
  assert.equal(models.update({ roles: { vision: { model: "cloudy/eyes", fallback: "ollama/qwen3.5:latest" } } as never }), null);
  fake.bodies.length = 0;
  const notes: string[] = [];
  const kept = await gateway.stream("vision", withPicture(), signal(), () => {}, (n) => notes.push(n));
  assert.equal(kept.ref, "ollama/qwen3.5:latest");
  assert.match(notes[0], /pictures, which stay on your PC/);
  assert.ok(fake.bodies.every((b) => !String(b.model).includes("eyes")));

  // Allowed: OpenAI-compatible providers get content parts with a data URL
  assert.equal(models.update({ roles: { vision: { allowPrivateToCloud: true } } as never }), null);
  fake.bodies.length = 0;
  const sent = await gateway.stream("vision", withPicture(), signal(), () => {}, () => {});
  assert.equal(sent.ref, "cloudy/eyes");
  const parts = (fake.bodies[0].messages as { content: { type: string; image_url?: { url: string } }[] }[])[0].content;
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].image_url?.url, `data:image/png;base64,${PNG_B64}`);
  assert.equal(models.update({ roles: { vision: { model: "ollama/qwen3.5:latest", allowPrivateToCloud: false, fallback: null } } as never }), null);
});

test("a model that can't see pictures is refused with a clear message", async () => {
  assert.equal(models.update({ roles: { vision: { model: "ollama/nolook:7b" } } as never }), null);
  await assert.rejects(
    gateway.stream("vision", withPicture(), signal(), () => {}, () => {}),
    /can't read pictures\. On the Team page, give the Vision agent a vision model/,
  );
  // Text-only requests to the same model are fine
  const out = await gateway.stream("vision", [{ role: "user", content: "hello" }], signal(), () => {}, () => {});
  assert.equal(out.text, "a cat");
});
