// Tests for Phases 0–2: the task store, queue order, per-agent models and providers.   npm test
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { boardColumn } from "../src/schemas/agent";
import { ModelRegistry, parseSwitchCommand, resolveTarget } from "../src/hq/models";
import { chatOnce, chatStream, normalizeRef, parseModelRef } from "../src/hq/providers";
import type { Provider } from "../src/hq/providers";
import { Task, TaskStore, dependenciesMet, pickNext, waitingOn } from "../src/hq/taskstore";

function card(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    prompt: id,
    targetAgent: "planner",
    requestedAgent: "planner",
    source: "ui",
    model: "",
    status: "queued",
    createdAt: 1000,
    events: [],
    ...extra,
  };
}

const map = (...ts: Task[]) => new Map(ts.map((t) => [t.id, t]));

test("tasks and events survive a restart; running work comes back interrupted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mc-"));
  const a = new TaskStore(dir);
  a.add(card("done", { status: "complete", answer: "42" }));
  a.add(card("mid-run", { status: "streaming", createdAt: 2000 }));
  a.add(card("waiting", { status: "queued", createdAt: 3000 }));
  a.add(card("sub", { status: "thinking", parentId: "mid-run", createdAt: 2001 }));
  a.appendEvent({ eventId: 1, taskId: "done", timestamp: 1, status: "streaming", activeSubAgent: "x", logChunk: "hello" });
  a.setSetting("k", { v: 1 });
  a.close();

  const b = new TaskStore(dir);
  assert.equal(b.load().recovered, 2);
  assert.equal(b.tasks.get("done")!.answer, "42");
  assert.equal(b.events("done")[0].logChunk, "hello");
  const mid = b.tasks.get("mid-run")!;
  assert.equal(mid.status, "error");
  assert.equal(mid.interrupted, true);
  assert.equal(b.tasks.get("sub")!.status, "canceled");
  assert.equal(b.tasks.get("waiting")!.status, "queued"); // still queued, will run
  assert.deepEqual(b.getSetting("k", null), { v: 1 });
  assert.equal(b.maxEventId(), 1);

  b.archive("mid-run");
  assert.ok(!b.tasks.has("mid-run") && !b.tasks.has("sub"));
  b.close();
  const c = new TaskStore(dir);
  c.load();
  assert.ok(!c.tasks.has("mid-run"));
  c.close();
});

test("queue order: priority, then board position, skipping blocked cards", () => {
  const all = map(
    card("low", { priority: "low", position: 1 }),
    card("normal-2", { position: 20 }),
    card("normal-1", { position: 10 }),
    card("high", { priority: "high", position: 99 }),
    card("blocked", { priority: "high", position: 0, dependsOn: ["dep"] }),
    card("dep", { status: "backlog" }),
    card("parked", { status: "backlog", priority: "high" }),
  );
  const modelOf = () => null;
  assert.equal(pickNext(all, { modelOf })!.id, "high");
  all.get("high")!.status = "complete";
  assert.equal(pickNext(all, { modelOf })!.id, "normal-1");
  assert.equal(dependenciesMet(all.get("blocked")!, all), false);
  assert.deepEqual(waitingOn(all.get("blocked")!, all), ["dep"]);
  all.get("dep")!.status = "complete";
  all.get("dep")!.needsReview = true;
  assert.notEqual(pickNext(all, { modelOf })!.id, "blocked"); // waits for review
  all.get("dep")!.acceptedAt = 1;
  assert.equal(pickNext(all, { modelOf })!.id, "blocked");
});

test("queue prefers the loaded model, but never starves the front card", () => {
  const now = 100_000;
  const all = map(card("front", { position: 1, queuedAt: now - 5_000 }), card("same-model", { position: 2, queuedAt: now }));
  const modelOf = (t: Task) => (t.id === "front" ? "ollama/qwen3:14b" : "ollama/qwen2.5-coder:14b");
  assert.equal(pickNext(all, { modelOf, lastModel: "ollama/qwen2.5-coder:14b", now })!.id, "same-model");
  all.get("front")!.queuedAt = now - 120_000; // waited too long
  assert.equal(pickNext(all, { modelOf, lastModel: "ollama/qwen2.5-coder:14b", now, maxWaitMs: 60_000 })!.id, "front");
});

test("board columns follow status and review", () => {
  assert.equal(boardColumn({ status: "backlog" }), "backlog");
  assert.equal(boardColumn({ status: "queued" }), "ready");
  assert.equal(boardColumn({ status: "streaming" }), "running");
  assert.equal(boardColumn({ status: "complete", needsReview: true }), "review");
  assert.equal(boardColumn({ status: "complete", needsReview: true, acceptedAt: 5 }), "done");
  assert.equal(boardColumn({ status: "error" }), "failed");
});

const providers: Provider[] = [
  { id: "ollama", name: "Ollama", kind: "ollama", baseUrl: "http://x", local: true },
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "http://y", apiKeyEnv: "OPENROUTER_API_KEY", local: false },
];

test("model references", () => {
  assert.deepEqual(parseModelRef("qwen3:14b", providers)?.model, "qwen3:14b");
  assert.equal(parseModelRef("qwen3:14b", providers)?.provider.id, "ollama");
  const r = parseModelRef("openrouter/anthropic/claude-sonnet-4.5", providers)!;
  assert.equal(r.provider.id, "openrouter");
  assert.equal(r.model, "anthropic/claude-sonnet-4.5");
  assert.equal(normalizeRef("qwen3:4b", providers), "ollama/qwen3:4b");
});

test("switch commands", () => {
  assert.deepEqual(parseSwitchCommand("switch to claude"), { role: "planner", target: "claude" });
  assert.deepEqual(parseSwitchCommand("Switch coder to local."), { role: "coder", target: "local" });
  assert.deepEqual(parseSwitchCommand("use openrouter/x/y for the browser"), { role: "browser", target: "openrouter/x/y" });
  assert.deepEqual(parseSwitchCommand("go local"), { role: "planner", target: "local" });
  assert.deepEqual(parseSwitchCommand("switch everyone to local"), { role: "all", target: "local" });
  assert.equal(parseSwitchCommand("switch the light to blue in my python app please now"), null);
  assert.equal(parseSwitchCommand("write a function to switch to dark mode"), null);
  assert.equal(parseSwitchCommand("switch banana to local"), null);
  const settings = { roles: {} as never, aliases: { local: "ollama/qwen3:14b" }, customProviders: [] };
  assert.equal(resolveTarget("local", settings, providers), "ollama/qwen3:14b");
  assert.equal(resolveTarget("ollama/llama3.1:8b", settings, providers), "ollama/llama3.1:8b");
  assert.equal(resolveTarget("typo", settings, providers), null);
});

test("per-agent models: defaults, updates, validation, daily limit fallback", () => {
  const store = new TaskStore(":memory:");
  const reg = new ModelRegistry(store, { model: "qwen3:14b", fastModel: "qwen3:4b", numCtx: 8192, think: false });
  assert.equal(reg.resolve("planner").ref, "ollama/qwen3:14b");
  assert.equal(reg.resolve("router").ref, "ollama/qwen3:4b");
  assert.equal(reg.update({ roles: { coder: { model: "qwen2.5-coder:14b", temperature: 0.2 } } as never }), null);
  assert.equal(reg.resolve("coder").ref, "ollama/qwen2.5-coder:14b");
  assert.equal(reg.resolve("planner").ref, "ollama/qwen3:14b"); // others unchanged
  assert.match(reg.update({ roles: { coder: { model: "x", temperature: 9 } } as never })!, /Temperature/);
  assert.match(reg.update({ customProviders: [{ id: "Bad Id", name: "x", baseUrl: "http://z" }] })!, /lowercase/);
  // A custom (cloud-like) provider with a daily cap falls back to local once over it
  assert.equal(
    reg.update({
      customProviders: [{ id: "mycloud", name: "My cloud", baseUrl: "http://cloud/v1", apiKeyEnv: "MYCLOUD_KEY" }],
      roles: { planner: { model: "mycloud/big", fallback: "ollama/qwen3:14b", dailyTokenLimit: 100 } } as never,
    }),
    null,
  );
  assert.equal(reg.resolve("planner").ref, "mycloud/big");
  store.recordUsage("planner", "mycloud/big", 80, 40);
  assert.equal(reg.resolve("planner").ref, "ollama/qwen3:14b");
  assert.equal(reg.resolve("planner", "ollama/llama3.1:8b").ref, "ollama/llama3.1:8b"); // explicit override wins
  // Settings persist in the store
  const reg2 = new ModelRegistry(store, { model: "qwen3:14b", fastModel: "qwen3:4b", numCtx: 8192, think: false });
  assert.equal(reg2.resolve("coder").ref, "ollama/qwen2.5-coder:14b");
});

test("OpenAI-compatible streaming, usage and JSON mode", async () => {
  const seen: { auth?: string; body?: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ auth: req.headers.authorization, body });
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const piece of ["Hel", "lo"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else if (body.response_format) {
        res.writeHead(400).end("response_format not supported");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({ choices: [{ message: { content: 'Sure: {"agent":"coder"}' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  process.env.TEST_CLOUD_KEY = "secret-key";
  const p: Provider = { id: "cloud", name: "Cloud", kind: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "TEST_CLOUD_KEY", local: false };
  let streamed = "";
  const out = await chatStream(p, "m", [{ role: "user", content: "hi" }], { temperature: 0.3 }, new AbortController().signal, (t) => (streamed += t));
  assert.equal(streamed, "Hello");
  assert.deepEqual([out.promptTokens, out.completionTokens], [7, 2]);
  assert.equal(seen[0].auth, "Bearer secret-key");
  const once = await chatOnce(p, "m", [{ role: "user", content: "route" }], { json: true });
  assert.deepEqual(once.json, { agent: "coder" }); // retried without response_format, parsed loosely
  server.close();
});
