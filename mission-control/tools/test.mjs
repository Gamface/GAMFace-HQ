import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, isReadOnly, parseConfig, resultText, serverEnv } from "./server.mjs";

test("config: names, commands and args are checked", () => {
  assert.throws(() => parseConfig('{"servers":{"Bad Name":{"command":"x"}}}'), /lowercase/);
  assert.throws(() => parseConfig('{"servers":{"a":{}}}'), /needs a command/);
  const s = parseConfig('{"servers":{"a":{"command":"node","args":["x.mjs"],"enabled":false}}}').a;
  assert.deepEqual([s.command, s.args, s.enabled, s.readOnly], ["node", ["x.mjs"], false, false]);
});

test("env: a server gets only the variables it names", () => {
  const env = serverEnv({ API_KEY: "$BRAVE", MODE: "fast", MISSING: "$NOPE" }, { BRAVE: "k123", SECRET: "no" });
  assert.equal(env.API_KEY, "k123");
  assert.equal(env.MODE, "fast");
  assert.equal(env.MISSING, undefined);
  assert.equal(env.SECRET, undefined);
});

test("read-only: per-tool setting, then server, then the tool's own hint", () => {
  const server = { readOnly: false, tools: { write: { readOnly: true } } };
  assert.equal(isReadOnly(server, { name: "write", annotations: {} }), true);
  assert.equal(isReadOnly(server, { name: "a", annotations: { readOnlyHint: true } }), true);
  assert.equal(isReadOnly(server, { name: "b", annotations: {} }), false);
  assert.equal(isReadOnly(server, { name: "c", annotations: { readOnlyHint: true, destructiveHint: true } }), false);
  assert.equal(isReadOnly({ readOnly: true, tools: {} }, { name: "d" }), true);
});

test("results: text joined, other parts named, long text cut", () => {
  assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "image", data: "…" }] }), "a\n[image omitted]");
  assert.equal(resultText({ content: [], structuredContent: { n: 1 } }), '{"n":1}');
  assert.match(resultText({ content: [{ type: "text", text: "x".repeat(20010) }] }), /\[cut: 10 more characters\]$/);
});

test("end to end with the demo server: list, call, and a change refused", async () => {
  const servers = parseConfig(JSON.stringify({ servers: { demo: { command: process.execPath, args: [new URL("./demo-server.mjs", import.meta.url).pathname] } } }));
  const srv = createServer(servers).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const list = await (await fetch(`${base}/tools`)).json();
    const tools = Object.fromEntries(list.servers[0].tools.map((t) => [t.name, t.readOnly]));
    assert.deepEqual(tools, { echo: true, time: true, add_note: false });
    const post = (body) => fetch(`${base}/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const echo = await (await post({ server: "demo", tool: "echo", args: { text: "hi" } })).json();
    assert.equal(echo.text, "hi");
    assert.equal(echo.isError, false);
    const refused = await post({ server: "demo", tool: "add_note", args: { text: "x" } });
    assert.equal(refused.status, 403);
    assert.equal((await post({ server: "nope", tool: "echo" })).status, 404);
  } finally {
    srv.close();
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 100).unref();
  }
});
