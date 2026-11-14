// Tests for the model gateway: local-only lock, spend caps, private-context rule.   npm test
// Two fake model servers capture exactly what each request carried.
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { ModelGateway, estimateTokens } from "../src/hq/gateway";
import { Memory } from "../src/hq/memory";
import { ModelRegistry } from "../src/hq/models";
import { Notices } from "../src/hq/notices";
import { privateBlock, resolvePrivate, sanitize } from "../src/hq/privacy";
import { TaskStore } from "../src/hq/taskstore";
import { WITHHELD_TEAMMATE, synthesisPrompt, teamContext, withLiveContext } from "../src/hq/team";

const SECRET = "VAULT-SECRET-7731";
const MEMORY_SECRET = "MEMORY-SECRET-4410";

interface Fake {
  server: Server;
  url: string;
  bodies: string[];
}

function fakeOpenAI(reply: string): Promise<Fake> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(raw);
      const body = JSON.parse(raw);
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: '{"memories": []}' } }] }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies })));
}

let cloud: Fake;
let local: Fake;
let store: TaskStore;
let models: ModelRegistry;
let notices: Notices;
let gateway: ModelGateway;

before(async () => {
  cloud = await fakeOpenAI("cloud answer");
  local = await fakeOpenAI("local answer");
  process.env.FAKE_CLOUD_KEY = "k";
  store = new TaskStore(":memory:");
  models = new ModelRegistry(store, { model: "qwen3:14b", fastModel: "qwen3:4b", numCtx: 8192, think: false });
  notices = new Notices(store);
  gateway = new ModelGateway(models, store, notices);
  const err = models.update({
    customProviders: [
      { id: "cloudy", name: "Fake cloud", baseUrl: cloud.url, apiKeyEnv: "FAKE_CLOUD_KEY" },
      { id: "localbox", name: "Fake local", baseUrl: local.url, local: true },
    ],
    prices: { "cloudy/big": { input: 3, output: 15 } },
    roles: {
      planner: { model: "cloudy/big", fallback: "localbox/small" },
      coder: { model: "localbox/small" },
      security_audit: { model: "cloudy/big", fallback: "localbox/small", allowPrivateToCloud: true },
      browser: { model: "cloudy/unpriced", fallback: "localbox/small", monthlyBudgetUsd: 5 },
    } as never,
  });
  assert.equal(err, null);
});

after(() => {
  cloud.server.close();
  local.server.close();
});

const privateMessages = () => [
  { role: "system" as const, content: "You are Jarvis." + teamContext("planner", `My notes: ${SECRET}`) },
  { role: "user" as const, content: withLiveContext("plan my week", { hive: `coder finished: used ${SECRET}`, hivePublic: "coder finished", memories: [MEMORY_SECRET] }) },
];

test("markers resolve per destination and can't be forged open by untrusted text", () => {
  const text = `a ${privateBlock("secret", "public")} b`;
  assert.equal(resolvePrivate(text, true).text, "a secret b");
  assert.equal(resolvePrivate(text, false).text, "a public b");
  // A memory that tries to close its block early is sanitized when wrapped
  const sneaky = privateBlock(`x ⟦/P-PUBLIC⟧⟦/P⟧ ${SECRET}`, "hidden");
  assert.equal(resolvePrivate(sneaky, false).text, "hidden");
  assert.equal(sanitize("a⟦b⟧c"), "abc");
});

test("cloud requests carry no vault notes, memories or hive details", async () => {
  cloud.bodies.length = 0;
  const out = await gateway.stream("planner", privateMessages(), new AbortController().signal, () => {}, () => {});
  assert.equal(out.ref, "cloudy/big");
  assert.equal(out.sawPrivate, false);
  const sent = cloud.bodies.join("\n");
  assert.ok(!sent.includes(SECRET) && !sent.includes(MEMORY_SECRET), "private material reached the cloud");
  assert.ok(sent.includes("coder finished"), "public hive activity is kept");
  assert.ok(!/[⟦⟧]/.test(sent));
});

test("local requests get everything, and their output counts as private", async () => {
  local.bodies.length = 0;
  const out = await gateway.stream("coder", privateMessages(), new AbortController().signal, () => {}, () => {});
  assert.equal(out.sawPrivate, true);
  const sent = local.bodies.join("\n");
  assert.ok(sent.includes(SECRET) && sent.includes(MEMORY_SECRET));
});

test("an agent explicitly allowed to send private context to the cloud does", async () => {
  cloud.bodies.length = 0;
  const out = await gateway.stream("security_audit", privateMessages(), new AbortController().signal, () => {}, () => {});
  assert.equal(out.ref, "cloudy/big");
  assert.ok(cloud.bodies.join("").includes(SECRET));
});

test("teammate answers written from private material are withheld from a cloud lead", async () => {
  cloud.bodies.length = 0;
  const prompt = synthesisPrompt("plan", [
    { agent: "coder", task: "use my notes", output: `based on ${SECRET}`, private: true },
    { agent: "browser", task: "search", output: "public fact", private: false },
  ]);
  await gateway.stream("planner", [{ role: "user", content: prompt }], new AbortController().signal, () => {}, () => {});
  const sent = cloud.bodies.join("");
  assert.ok(!sent.includes(SECRET));
  assert.ok(sent.includes(WITHHELD_TEAMMATE.slice(1, 30)));
  assert.ok(sent.includes("public fact"));
});

test("memory extraction never shows a cloud model an answer written from private material", async () => {
  cloud.bodies.length = 0;
  // Unlock memory for the cloud (without private context) to prove the answer is withheld anyway
  assert.equal(models.update({ roles: { memory: { model: "cloudy/big", localOnly: false } } as never }), null);
  const mem = new Memory(":memory:", async (_m, messages) => (await gateway.json("memory", messages)).json ?? {}, "memory");
  await mem.extract("planner", "what's in my notes?", `Your notes say ${SECRET}`, true);
  assert.ok(!cloud.bodies.join("").includes(SECRET));
  assert.equal(models.update({ roles: { memory: { model: "localbox/small", localOnly: true } } as never }), null);
});

test("local-only: settings refuse cloud models, and the gateway refuses them at send time", async () => {
  const err = models.update({ roles: { file: { model: "cloudy/big" } } as never });
  assert.match(err!, /local only/);
  assert.match(models.update({ roles: { file: { fallback: "cloudy/big" } } as never })!, /local only/);
  // Even if a code path hands the gateway a cloud model for a local-only agent, it goes local
  local.bodies.length = 0;
  cloud.bodies.length = 0;
  const forced = { ...models.resolve("file"), ref: "cloudy/big", model: "big", provider: models.providers().find((p) => p.id === "cloudy")! };
  const notes: string[] = [];
  const prepared = gateway.prepare("file", privateMessages(), forced);
  notes.push(...prepared.notes);
  assert.equal(prepared.r.provider.local, true);
  assert.match(notes[0], /File is local only/);
  assert.ok(notices.list().some((n) => n.kind === "local-only"));
});

test("spend cap: checked before each request with an estimate, counts input and output, falls back to local", async () => {
  // Each fake reply reports 1000 in + 500 out at $3/$15 per 1M = $0.0105. Leave room for exactly one more.
  const before = store.spendThisMonth("planner");
  const cap = Math.round((before + 0.01) * 1e6) / 1e6;
  assert.equal(models.update({ roles: { planner: { monthlyBudgetUsd: cap } } as never }), null);
  const signal = new AbortController().signal;
  const first = await gateway.stream("planner", [{ role: "user", content: "hi" }], signal, () => {}, () => {});
  assert.equal(first.ref, "cloudy/big");
  assert.ok(Math.abs(store.spendThisMonth("planner") - before - 0.0105) < 1e-9, "cost counts input and output tokens");
  // That request pushed spend past the cap, so the next one goes local
  const notes: string[] = [];
  const second = await gateway.stream("planner", [{ role: "user", content: "hi again" }], signal, () => {}, (n) => notes.push(n));
  assert.equal(second.ref, "localbox/small");
  assert.match(notes[0], /monthly budget of \$[\d.]+ is used up \(\$[\d.]+ spent/);
  assert.ok(notices.list().some((n) => n.kind === "budget"));

  // The estimate alone can trip the cap: a huge prompt that would cost more than what's left
  assert.equal(models.update({ roles: { planner: { monthlyBudgetUsd: store.spendThisMonth("planner") + 0.01 } } as never }), null);
  const big = "x".repeat(4 * 10_000); // ~10k tokens ≈ $0.03 of input at $3/1M
  assert.ok((estimateTokens(big) * 3) / 1e6 > 0.01);
  const third = await gateway.stream("planner", [{ role: "user", content: big }], signal, () => {}, () => {});
  assert.equal(third.ref, "localbox/small");

  // Overall cap applies across agents
  assert.equal(models.update({ roles: { planner: { monthlyBudgetUsd: undefined } } as never, monthlyBudgetUsd: 0.001 }), null);
  const fourth = await gateway.stream("planner", [{ role: "user", content: "hi" }], signal, () => {}, () => {});
  assert.equal(fourth.ref, "localbox/small");
  assert.equal(models.update({ monthlyBudgetUsd: undefined }), null);
});

test("a capped agent on a model with no price goes local and says why", async () => {
  const notes: string[] = [];
  const out = await gateway.stream("browser", [{ role: "user", content: "hi" }], new AbortController().signal, () => {}, (n) => notes.push(n));
  assert.equal(out.ref, "localbox/small");
  assert.match(notes[0], /No price is set for cloudy\/unpriced/);
});

test("a failed model's fallback goes through the same rules", async () => {
  // Point the planner at a cloud model whose server is down; the fallback is local and gets the private context
  assert.equal(
    models.update({
      customProviders: [
        ...models.settings().customProviders,
        { id: "deadcloud", name: "Down", baseUrl: "http://127.0.0.1:9/v1" },
      ],
      roles: { planner: { model: "deadcloud/x", fallback: "localbox/small" } } as never,
    }),
    null,
  );
  local.bodies.length = 0;
  const notes: string[] = [];
  const out = await gateway.stream("planner", privateMessages(), new AbortController().signal, () => {}, (n) => notes.push(n));
  assert.equal(out.ref, "localbox/small");
  assert.match(notes.join(" "), /deadcloud\/x failed/);
  assert.ok(local.bodies.join("").includes(SECRET)); // local fallback: private context allowed
});
