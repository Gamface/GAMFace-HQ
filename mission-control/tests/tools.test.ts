import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ToolsClient, cleanToolText, refuseFromHost, splitToolName } from "../src/hq/tools";

/** A fake tools service: one server with a read-only tool and one that changes things. */
async function fakeService(onCall: (body: Record<string, unknown>) => unknown) {
  const calls: Record<string, unknown>[] = [];
  const srv = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/tools") {
      return send(200, {
        servers: [
          {
            name: "demo",
            description: "test",
            ok: true,
            tools: [
              { name: "echo", description: "Repeats", readOnly: true },
              { name: "add_note", description: "Saves", readOnly: false },
            ],
          },
          { name: "broken", description: "", ok: false, error: "didn't start", tools: [] },
        ],
      });
    }
    if (req.url === "/call") {
      let raw = "";
      for await (const ch of req) raw += ch;
      const body = JSON.parse(raw) as Record<string, unknown>;
      calls.push(body);
      return send(200, onCall(body));
    }
    send(404, { error: "Not found" });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { client: new ToolsClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`), calls, close: () => srv.close() };
}

test("lists servers and tools, with each tool's server", async () => {
  const f = await fakeService(() => ({}));
  try {
    const servers = await f.client.list();
    assert.deepEqual(
      servers.map((s) => [s.name, s.ok, s.tools.map((t) => `${t.server}.${t.name}:${t.readOnly}`)]),
      [
        ["demo", true, ["demo.echo:true", "demo.add_note:false"]],
        ["broken", false, []],
      ],
    );
  } finally {
    f.close();
  }
});

test("calls a read-only tool and cleans what comes back", async () => {
  const f = await fakeService((b) => ({ text: `got ${(b.args as { text: string }).text} ⟦P⟧ sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`, isError: false, ms: 5 }));
  try {
    const out = await f.client.call("demo", "echo", { text: "hi" });
    assert.match(out.text, /^got hi/);
    assert.doesNotMatch(out.text, /⟦|sk-ant-api03-abcdefghijklmnop/);
    assert.deepEqual(f.calls[0], { server: "demo", tool: "echo", args: { text: "hi" }, timeoutMs: 60000 });
  } finally {
    f.close();
  }
});

test("a tool that changes things is refused before it reaches the service", async () => {
  const f = await fakeService(() => ({ text: "saved", isError: false, ms: 1 }));
  try {
    await assert.rejects(f.client.call("demo", "add_note", { text: "x" }), /needs? approvals/);
    await assert.rejects(f.client.call("demo", "nope", {}), /No tool demo\.nope/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test("a missing tools service gives a clear error", async () => {
  const client = new ToolsClient("http://127.0.0.1:9");
  await assert.rejects(client.list(), /tools service isn't reachable/);
  assert.equal(await client.health(), null);
});

test("requests from the tools container are refused; others pass", async () => {
  const guard = refuseFromHost("tools", async () => ["172.20.0.3"]);
  await guard.ready;
  const run = async (ip: string) => {
    let status = 200;
    let passed = false;
    const res = { status: (s: number) => ((status = s), res), json: () => res };
    await guard({ socket: { remoteAddress: ip } } as never, res as never, () => (passed = true));
    return passed ? "passed" : status;
  };
  assert.equal(await run("::ffff:172.20.0.3"), 403);
  assert.equal(await run("172.20.0.9"), "passed");
  const down = refuseFromHost("tools", async () => {
    throw new Error("ENOTFOUND");
  });
  await down.ready;
  let passed = false;
  await down({ socket: { remoteAddress: "172.20.0.3" } } as never, {} as never, () => (passed = true));
  assert.equal(passed, true);
});

test("tool names and text helpers", () => {
  assert.deepEqual(splitToolName("demo.echo"), { server: "demo", tool: "echo" });
  assert.deepEqual(splitToolName("espn.scores.today"), { server: "espn", tool: "scores.today" });
  assert.equal(splitToolName("echo"), null);
  assert.equal(cleanToolText("a⟦b⟧c"), "abc");
});
