// colibri as a local provider, its nicknames, and per-agent time limits.   npm test
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { ModelGateway } from "../src/hq/gateway";
import { ModelRegistry, parseSwitchCommand, resolveTarget } from "../src/hq/models";
import { Notices } from "../src/hq/notices";
import { builtinProviders } from "../src/hq/providers";
import { TaskStore } from "../src/hq/taskstore";
import { teamContext } from "../src/hq/team";

const SECRET = "VAULT-SECRET-5521";

let colibri: { server: Server; url: string; bodies: string[] };
let models: ModelRegistry;
let gateway: ModelGateway;

before(async () => {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(raw);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "colibri answer" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  colibri = { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies };

  process.env.COLIBRI_BASE_URL = `${colibri.url}/`;
  const store = new TaskStore(":memory:");
  models = new ModelRegistry(store, {
    model: "qwen3:14b",
    fastModel: "qwen3:4b",
    numCtx: 8192,
    think: false,
    colibriModel: "qwen3.6-35b-a3b",
    colibriBigModel: "deepseek-v4-flash",
  });
  gateway = new ModelGateway(models, store, new Notices(store));
});

after(() => {
  colibri.server.close();
  delete process.env.COLIBRI_BASE_URL;
});

test("colibri is a built-in local provider only when COLIBRI_BASE_URL is set", () => {
  assert.equal(builtinProviders({}).find((p) => p.id === "colibri"), undefined);
  const p = builtinProviders({ COLIBRI_BASE_URL: "http://host.docker.internal:8090/v1//" }).find((x) => x.id === "colibri");
  assert.ok(p);
  assert.equal(p.local, true);
  assert.equal(p.kind, "openai");
  assert.equal(p.baseUrl, "http://host.docker.internal:8090/v1");
});

test("the colibri and colibri-big nicknames work in switch commands", () => {
  const settings = models.settings();
  const providers = models.providers();
  assert.deepEqual(parseSwitchCommand("switch jarvis to colibri-big"), { role: "planner", target: "colibri-big" });
  assert.equal(resolveTarget("colibri", settings, providers), "colibri/qwen3.6-35b-a3b");
  assert.equal(resolveTarget("colibri-big", settings, providers), "colibri/deepseek-v4-flash");
  // A custom provider can't take the built-in id
  assert.match(models.update({ customProviders: [{ id: "colibri", name: "x", baseUrl: "http://x/v1" }] })!, /built-in/);
});

test("a local-only agent may use colibri, and private context reaches it", async () => {
  assert.equal(models.update({ roles: { file: { model: "colibri/qwen3.6-35b-a3b", localOnly: true } } as never }), null);
  const out = await gateway.stream(
    "file",
    [
      { role: "system", content: "You are Jarvis File." + teamContext("file", `My notes: ${SECRET}`) },
      { role: "user", content: "what do my notes say?" },
    ],
    new AbortController().signal,
    () => {},
    () => {},
  );
  assert.equal(out.ref, "colibri/qwen3.6-35b-a3b");
  assert.equal(out.text, "colibri answer");
  assert.equal(out.sawPrivate, true);
  assert.ok(colibri.bodies.join("").includes(SECRET), "a local provider gets the private context");
});

test("per-agent time limits: validated, cleared with null, read back in ms", () => {
  assert.equal(models.timeoutMs("browser"), undefined);
  assert.equal(models.update({ roles: { browser: { timeoutMinutes: 360 } } as never }), null);
  assert.equal(models.timeoutMs("browser"), 360 * 60_000);
  assert.match(models.update({ roles: { browser: { timeoutMinutes: 0 } } as never })!, /Time limit/);
  assert.match(models.update({ roles: { browser: { timeoutMinutes: 2000 } } as never })!, /Time limit/);
  assert.match(models.update({ roles: { browser: { timeoutMinutes: 1.5 } } as never })!, /Time limit/);
  assert.equal(models.update({ roles: { browser: { timeoutMinutes: null } } as never }), null);
  assert.equal(models.timeoutMs("browser"), undefined);
});
