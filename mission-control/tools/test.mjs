import assert from "node:assert/strict";
import { test } from "node:test";
import { callArgs, createServer, isReadOnly, parseConfig, resultMedia, resultText, serverEnv, serverHeaders, startupError, visibleSchema } from "./server.mjs";
import { runError, workflow } from "./images-server.mjs";
import { cleanPath, cleanRef, listFiles, readFile, recentChanges, searchCode, showCommit } from "./code-server.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiUrl, plain } from "./wikipedia-server.mjs";
import { formatResults, searchUrl } from "./brave-server.mjs";

test("only: an allowlist of a server's tools", async () => {
  assert.throws(() => parseConfig('{"servers":{"a":{"command":"x","only":"echo"}}}'), /only must be a list/);
  const servers = parseConfig(JSON.stringify({ servers: { demo: { command: process.execPath, args: [new URL("./demo-server.mjs", import.meta.url).pathname], only: ["echo"] } } }));
  const srv = createServer(servers).listen(0);
  try {
    const list = await (await fetch(`http://127.0.0.1:${srv.address().port}/tools`)).json();
    assert.deepEqual(list.servers[0].tools.map((t) => t.name), ["echo"]);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server: "demo", tool: "time" }) });
    assert.equal(r.status, 404, "a tool left out of the allowlist can't be called");
  } finally {
    srv.close();
  }
});

test("hideParams and defaults: plumbing hidden from agents, defaults only where a tool has them", () => {
  const s = parseConfig(JSON.stringify({ servers: { espn: { command: "x", hideParams: ["agent", "yes"], defaults: { agent: true } } } })).espn;
  const schema = { type: "object", properties: { agent: { type: "boolean" }, yes: { type: "boolean" }, league: { type: "string" } }, required: ["league", "yes"] };
  assert.deepEqual(visibleSchema(s, schema), { type: "object", properties: { league: { type: "string" } }, required: ["league"] });
  // A hidden parameter the agent sends anyway is dropped; the default is added
  assert.deepEqual(callArgs(s, schema, { league: "nba", yes: true }), { league: "nba", agent: true });
  // A tool without that parameter doesn't get the default
  assert.deepEqual(callArgs(s, { properties: { league: {} } }, { league: "nba" }), { league: "nba" });
  assert.throws(() => parseConfig('{"servers":{"a":{"command":"x","defaults":[1]}}}'), /defaults must be an object/);
});

test("wikipedia: only wikipedia.org, plain-text snippets", () => {
  assert.match(apiUrl("en", { action: "query", srsearch: "a b" }), /^https:\/\/en\.wikipedia\.org\/w\/api\.php\?format=json&formatversion=2&utf8=1&action=query&srsearch=a\+b$/);
  assert.throws(() => apiUrl("evil.example/x?", {}), /language code/);
  assert.equal(plain('The <span class="searchmatch">Eiffel</span> Tower &amp; &quot;more&quot;'), 'The Eiffel Tower & "more"');
});

test("brave: only api.search.brave.com, numbered results", () => {
  assert.equal(searchUrl("web", { query: "node lts", count: 5, freshness: "pw" }), "https://api.search.brave.com/res/v1/web/search?q=node+lts&count=5&freshness=pw");
  assert.equal(
    formatResults([{ title: "<strong>Node</strong> 24", url: "https://nodejs.org", description: "LTS <strong>release</strong>", age: "2 days ago" }]),
    "1. Node 24 (2 days ago)\n   https://nodejs.org\n   LTS release",
  );
});

test("online servers: https url only, no credentials in it, headers read from tools/.env", () => {
  const s = parseConfig('{"servers":{"inspo":{"url":"https://inspomcp.dev/api/mcp","headers":{"Authorization":"$INSPO_KEY"}}}}').inspo;
  assert.deepEqual([s.url, s.command], ["https://inspomcp.dev/api/mcp", ""]);
  assert.deepEqual(serverHeaders(s.headers, { INSPO_KEY: "Bearer k1", OTHER: "no" }), { Authorization: "Bearer k1" });
  assert.deepEqual(serverHeaders({ "X-Key": "$MISSING", "X-Mode": "lite" }, {}), { "X-Mode": "lite" });
  assert.throws(() => parseConfig('{"servers":{"a":{"url":"http://example.com/mcp"}}}'), /must start with https/);
  assert.throws(() => parseConfig('{"servers":{"a":{"url":"https://u:p@example.com/mcp"}}}'), /not in the url/);
  assert.throws(() => parseConfig('{"servers":{"a":{"url":"not a url"}}}'), /valid address/);
  assert.throws(() => parseConfig('{"servers":{"a":{"url":"https://example.com","command":"x"}}}'), /not both/);
  assert.throws(() => parseConfig('{"servers":{"a":{"url":"https://example.com","headers":{"X":1}}}}'), /headers must be/);
});

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

test("pictures and clips: passed on beside the text, only known types, at most four", () => {
  const png = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
  const mp4 = { type: "resource", resource: { uri: "comfyui://clip.mp4", mimeType: "video/mp4", blob: "AAAAIGZ0eXA=" } };
  const res = { content: [{ type: "text", text: "Made it" }, png, { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }, mp4] };
  assert.equal(resultText(res), "Made it\n[image omitted]", "the PNG and MP4 travel separately; an SVG isn't passed on");
  assert.deepEqual(resultMedia(res), [
    { mimeType: "image/png", data: "iVBORw0KGgo=" },
    { mimeType: "video/mp4", data: "AAAAIGZ0eXA=" },
  ]);
  assert.equal(resultMedia({ content: Array(6).fill(png) }).length, 4);
  assert.deepEqual(resultMedia({ content: [{ type: "image", mimeType: "image/png", data: "" }] }), []);
  assert.deepEqual(resultMedia({ content: [{ type: "resource", resource: { uri: "x", mimeType: "video/webm", blob: "AAAA" } }] }), [], "only MP4 clips");
});

test("timeoutMs: a slow server may run longer, within limits", () => {
  const s = parseConfig(JSON.stringify({ servers: { a: { command: "x", timeoutMs: 600000 }, b: { command: "x", timeoutMs: 99999999 }, c: { command: "x" } } }));
  assert.equal(s.a.timeoutMs, 600000);
  assert.equal(s.b.timeoutMs, 600000);
  assert.equal(s.c.timeoutMs, undefined);
});

test("images: a Z-Image Turbo workflow with the prompt, size and seed", () => {
  const wf = workflow({ prompt: "a sunrise over the sea", size: "portrait", seed: 7 });
  assert.equal(wf[5].inputs.text, "a sunrise over the sea");
  assert.deepEqual([wf[7].inputs.width, wf[7].inputs.height], [832, 1216]);
  assert.equal(wf[8].inputs.seed, 7);
  assert.equal(wf[8].inputs.steps, 8);
  assert.deepEqual([workflow({ prompt: "x", size: "nope", seed: 1 })[7].inputs.width], [1024]);
  assert.equal(runError({ status: { status_str: "error", messages: [["execution_error", { node_type: "KSampler", exception_message: "out of memory\nmore" }]] } }), "KSampler failed: out of memory");
});
test("a server that won't start reports its own error line", () => {
  assert.equal(startupError("Error: authentication required: set GITHUB_PERSONAL_ACCESS_TOKEN\nUsage:\n  github-mcp-server"), "authentication required: set GITHUB_PERSONAL_ACCESS_TOKEN");
  assert.equal(startupError("starting up\nlistening"), "");
});

test("code: paths and refs that could escape or inject are refused", () => {
  assert.equal(cleanPath("./mission-control/src/"), "mission-control/src");
  assert.equal(cleanPath(""), "");
  for (const bad of ["../etc/passwd", "a/../../b", "--output=x", "a\nb"]) assert.throws(() => cleanPath(bad), /Not a usable path/, bad);
  assert.equal(cleanRef(), "HEAD");
  assert.equal(cleanRef("HEAD~2"), "HEAD~2");
  for (const bad of ["--all", "a..b", "x;rm -rf", ""]) if (bad) assert.throws(() => cleanRef(bad), /Not a usable/, bad);
});

test("code: reads only what's committed, through git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "app.ts"), "export const answer = 42;\n// TODO: tidy\n");
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, ".env"), "SECRET=hunter2\n");
  g("add", ".");
  g("commit", "-q", "-m", "First commit");
  writeFileSync(join(dir, "src", "draft.ts"), "not committed\n");
  const opts = { gitDir: join(dir, ".git") };
  assert.deepEqual((await listFiles({}, opts)).split("\n"), [".gitignore", "src/app.ts"], "uncommitted and ignored files aren't there");
  assert.match(await readFile({ path: "src/app.ts" }, opts), /1  export const answer = 42;/);
  await assert.rejects(readFile({ path: ".env" }, opts), "the ignored .env can't be read");
  assert.match(await searchCode({ pattern: "todo" }, opts), /^src\/app.ts:2:\/\/ TODO: tidy$/);
  assert.match(await searchCode({ pattern: "nothing-like-this" }, opts), /No matches/);
  assert.match(await recentChanges({ count: 5 }, opts), /First commit/);
  assert.match(await showCommit({ ref: "HEAD" }, opts), /\+export const answer = 42;/);
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
