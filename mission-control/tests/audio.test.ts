// Tests for audio uploads and transcription.   npm test
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
import { privateBlock, resolvePrivate } from "../src/hq/privacy";
import { TaskStore } from "../src/hq/taskstore";
import { Uploads } from "../src/hq/uploads";
import { parseWav, splitWav } from "../src/hq/wav";

/** 16 kHz mono 16-bit PCM WAV of the given length (a quiet tone). */
function makeWav(seconds: number, rate = 16000): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 2000), 44 + i * 2);
  return b;
}

test("WAV header parsing and splitting into clips under 30 seconds", () => {
  const info = parseWav(makeWav(5))!;
  assert.deepEqual([info.sampleRate, info.channels, info.bitsPerSample, info.format], [16000, 1, 16, 1]);
  assert.ok(Math.abs(info.seconds - 5) < 0.01);
  assert.equal(splitWav(makeWav(20)).length, 1);
  const clips = splitWav(makeWav(70));
  assert.equal(clips.length, 3);
  const lengths = clips.map((c) => parseWav(c)!.seconds);
  assert.ok(lengths.every((s) => s <= 28.0001));
  assert.ok(Math.abs(lengths.reduce((a, b) => a + b, 0) - 70) < 0.01, "no audio is lost when splitting");
  assert.equal(parseWav(Buffer.from("ID3 not a wav file at all")), null);
});

test("audio uploads accept WAV only, and pictures and audio don't cross over", () => {
  const up = new Uploads(mkdtempSync(path.join(tmpdir(), "au-")));
  const wav = makeWav(2);
  const ok = up.save(`data:audio/wav;base64,${wav.toString("base64")}`, "audio");
  assert.ok(!("error" in ok));
  if ("error" in ok) return;
  assert.match(ok.id, /^[a-f0-9]{64}\.wav$/);
  assert.equal(ok.seconds, 2);
  assert.ok(up.bytes(ok.id)!.equals(wav));
  assert.match((up.save(Buffer.from("ID3\x04fake mp3").toString("base64"), "audio") as { error: string }).error, /must be WAV/);
  // A WAV isn't accepted as a picture
  assert.match((up.save(wav.toString("base64"), "image") as { error: string }).error, /Only PNG, JPEG/);
});

test("a private block cut off by truncation is still withheld", () => {
  const whole = `before ${privateBlock("SECRET transcript text", "public")} after`;
  const cut = whole.slice(0, whole.indexOf("transcript")); // end marker lost
  const cloud = resolvePrivate(cut, false);
  assert.ok(!cloud.text.includes("SECRET"));
  assert.match(cloud.text, /^before {2}?\(private content withheld\)|^before \(private content withheld\)/);
  assert.equal(cloud.hadPrivate, true);
  assert.ok(resolvePrivate(cut, true).text.includes("SECRET"));
});

interface Fake {
  server: Server;
  url: string;
  hits: { path: string; model?: string; hasFile: boolean }[];
}

/** Fake Ollama + OpenAI server: /api/show (gemma4 has audio), /v1/audio/transcriptions and /audio/transcriptions. */
function fakeServer(): Promise<Fake> {
  const hits: Fake["hits"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.url === "/api/show") {
        const model = JSON.parse(raw.toString()).model as string;
        return res.end(JSON.stringify({ capabilities: model.startsWith("gemma4") ? ["completion", "vision", "audio"] : ["completion"] }));
      }
      const text = raw.toString("latin1");
      const model = /name="model"\r\n\r\n([^\r]+)/.exec(text)?.[1];
      hits.push({ path: req.url ?? "", model, hasFile: text.includes('name="file"') && text.includes("RIFF") });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ text: `heard ${hits.length}` }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits })));
}

let fake: Fake;
let models: ModelRegistry;
let gateway: ModelGateway;

before(async () => {
  fake = await fakeServer();
  process.env.OLLAMA_BASE_URL = fake.url;
  process.env.AUDIO_FAKE_KEY = "k";
  const store = new TaskStore(":memory:");
  models = new ModelRegistry(store, { model: "qwen3:14b", fastModel: "qwen3:4b", audioModel: "gemma4:12b", numCtx: 8192, think: false });
  gateway = new ModelGateway(models, store, new Notices(store));
  assert.equal(
    models.update({
      customProviders: [
        { id: "whisper", name: "Local Whisper", baseUrl: `${fake.url}/whisper/v1`, local: true },
        { id: "cloudy", name: "Cloud", baseUrl: `${fake.url}/cloud/v1`, apiKeyEnv: "AUDIO_FAKE_KEY" },
      ],
    }),
    null,
  );
});

after(() => fake.server.close());

test("the Transcriber defaults to local gemma4 and is local-only", () => {
  assert.equal(models.resolve("audio").ref, "ollama/gemma4:12b");
  assert.equal(models.settings().roles.audio.localOnly, true);
  assert.match(models.update({ roles: { audio: { model: "cloudy/whisper-1" } } as never })!, /local only/);
});

test("Ollama transcription goes to /v1/audio/transcriptions with the WAV and model", async () => {
  fake.hits.length = 0;
  const out = await gateway.transcribe(makeWav(3), undefined);
  assert.equal(out.ref, "ollama/gemma4:12b");
  assert.equal(out.text, "heard 1");
  assert.deepEqual(fake.hits[0], { path: "/v1/audio/transcriptions", model: "gemma4:12b", hasFile: true });
});

test("a local Whisper server works too (OpenAI-style path)", async () => {
  assert.equal(models.update({ roles: { audio: { model: "whisper/Systran/faster-whisper-small" } } as never }), null);
  fake.hits.length = 0;
  const out = await gateway.transcribe(makeWav(1), undefined);
  assert.equal(out.ref, "whisper/Systran/faster-whisper-small");
  assert.equal(fake.hits[0].path, "/whisper/v1/audio/transcriptions");
});

test("audio stays local unless the Transcriber may send private context, and never under a spend cap", async () => {
  // Unlock local-only, point at the cloud: audio still stays local without permission
  assert.equal(models.update({ roles: { audio: { localOnly: false, model: "cloudy/whisper-1", fallback: "ollama/gemma4:12b" } } as never }), null);
  fake.hits.length = 0;
  const notes: string[] = [];
  const kept = await gateway.transcribe(makeWav(1), undefined, (n) => notes.push(n));
  assert.equal(kept.ref, "ollama/gemma4:12b");
  assert.match(notes[0], /Audio stays on your PC/);
  assert.ok(fake.hits.every((h) => !h.path.startsWith("/cloud")));
  // Allowed, but a spend cap applies: still local (audio spend can't be measured)
  assert.equal(models.update({ roles: { audio: { allowPrivateToCloud: true, monthlyBudgetUsd: 5 } } as never }), null);
  const capped = await gateway.transcribe(makeWav(1), undefined, (n) => notes.push(n));
  assert.equal(capped.ref, "ollama/gemma4:12b");
  assert.match(notes.at(-1)!, /spend cap is set/);
  // Allowed and no caps: the cloud is used
  assert.equal(models.update({ roles: { audio: { monthlyBudgetUsd: null } } as never, monthlyBudgetUsd: null } as never), null);
  fake.hits.length = 0;
  const sent = await gateway.transcribe(makeWav(1), undefined);
  assert.equal(sent.ref, "cloudy/whisper-1");
  assert.equal(fake.hits[0].path, "/cloud/v1/audio/transcriptions");
  assert.equal(models.update({ roles: { audio: { model: "ollama/gemma4:12b", localOnly: true, allowPrivateToCloud: false, fallback: null } } as never }), null);
});

test("a model without audio is refused with a clear message", async () => {
  assert.equal(models.update({ roles: { audio: { model: "ollama/qwen3:14b" } } as never }), null);
  await assert.rejects(gateway.transcribe(makeWav(1), undefined), /can't take audio\. On the Team page, give the Transcriber an audio model/);
});
