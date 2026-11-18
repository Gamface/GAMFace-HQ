import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonChat } from "../src/hq/ollama";
import { delegationRules, parseDelegations, rosterText, routeTask, setToolsSummary } from "../src/hq/team";
import { describeParams, runToolAgent, toolList } from "../src/hq/tool-agent";
import type { ToolInfo, ToolResult } from "../src/hq/tools";

const TOOLS: ToolInfo[] = [
  { server: "demo", name: "time", description: "The current date and time in UTC", inputSchema: { type: "object", properties: {} }, readOnly: true },
  {
    server: "demo",
    name: "echo",
    description: "Repeats the text back",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "What to repeat" } }, required: ["text"] },
    readOnly: true,
  },
];

/** A fake model that replies with the given actions in order (the last one repeats). */
function script(actions: Record<string, unknown>[]): JsonChat & { seen: string[] } {
  let i = 0;
  const seen: string[] = [];
  return Object.assign(
    async (_m: string, messages: { content: string }[]) => {
      seen.push(messages[messages.length - 1].content);
      return actions[Math.min(i++, actions.length - 1)];
    },
    { seen },
  );
}

function fakeCall(results: Record<string, ToolResult | Error>) {
  const calls: string[] = [];
  const call = async (server: string, tool: string, args: Record<string, unknown>) => {
    calls.push(`${server}.${tool} ${JSON.stringify(args)}`);
    const r = results[`${server}.${tool}`];
    if (r instanceof Error) throw r;
    return r ?? { text: "ok", isError: false, ms: 1 };
  };
  return { call, calls };
}

const base = { tools: TOOLS, model: "m", maxSteps: 6, signal: new AbortController().signal, log: () => {} };

test("calls a tool, sees its result, and answers from it", async () => {
  const { call, calls } = fakeCall({ "demo.time": { text: "2026-11-18T15:00:00Z", isError: false, ms: 2 } });
  const chat = script([{ action: "call", tool: "demo.time", args: {} }, { action: "answer", answer: "It's 15:00 UTC (demo.time)." }]);
  const answer = await runToolAgent({ ...base, task: "What time is it in UTC?", call, chat });
  assert.equal(answer, "It's 15:00 UTC (demo.time).");
  assert.deepEqual(calls, ["demo.time {}"]);
  assert.match(chat.seen[1], /RESULT \(untrusted\):\n2026-11-18T15:00:00Z/);
});

test("unknown tools and repeated calls are skipped; three skips force an answer", async () => {
  const { call, calls } = fakeCall({});
  const chat = script([
    { action: "call", tool: "demo.time", args: {} },
    { action: "call", tool: "demo.time", args: {} }, // same call right after it worked: skipped
    { action: "call", tool: "weather.now", args: {} }, // no such tool: skipped
    { action: "call", tool: "demo.time", args: {} }, // skipped again: forced answer next
    { action: "answer", answer: "done" },
  ]);
  const answer = await runToolAgent({ ...base, task: "time", call, chat });
  assert.equal(answer, "done");
  assert.deepEqual(calls, ["demo.time {}"]);
  assert.match(chat.seen[4], /out of steps/);
});

test("a failed call gets one retry, then it's skipped", async () => {
  const { call, calls } = fakeCall({ "demo.echo": new Error("timeout") });
  const chat = script([
    { action: "call", tool: "demo.echo", args: { text: "a" } },
    { action: "call", tool: "demo.echo", args: { text: "a" } },
    { action: "call", tool: "demo.echo", args: { text: "a" } },
    { action: "answer", answer: "The echo tool kept failing." },
  ]);
  const answer = await runToolAgent({ ...base, task: "echo a", call, chat });
  assert.equal(calls.length, 2);
  assert.equal(answer, "The echo tool kept failing.");
});

test("with no tools it says so without asking the model", async () => {
  const chat = script([{ action: "answer", answer: "x" }]);
  const answer = await runToolAgent({ ...base, tools: [], task: "anything", call: fakeCall({}).call, chat });
  assert.match(answer, /No tools are installed/);
  assert.equal(chat.seen.length, 0);
});

test("the tool list shows names, descriptions and parameters", () => {
  assert.equal(describeParams(TOOLS[1].inputSchema), "text: string (What to repeat)");
  assert.equal(describeParams({ properties: { n: { type: "number" } } }), "n?: number");
  assert.equal(describeParams(undefined), "no parameters");
  assert.match(toolList(TOOLS), /- demo\.echo: Repeats the text back\n {2}parameters: text: string/);
  const note: ToolInfo = { server: "demo", name: "add_note", description: "Saves a note", readOnly: false };
  assert.match(toolList([note]), /- demo\.add_note \[CHANGES THINGS: the user approves each call\]: Saves a note/);
});

test("the Tools teammate is offered only while tools are installed", async () => {
  try {
    setToolsSummary(null);
    assert.doesNotMatch(rosterText(), /- tools:/);
    assert.doesNotMatch(delegationRules(), /tools/);
    assert.deepEqual(parseDelegations("@tools: what time is it"), []);
    const toTools = script([{ agent: "tools", reason: "tool" }]);
    assert.equal((await routeTask(toTools, "m", "what time is it")).agent, "planner");

    setToolsSummary("demo: time (The current date and time)");
    assert.match(rosterText(), /- tools: Jarvis Tools, .*Installed: demo: time/);
    assert.match(delegationRules(), /Valid teammates: .*tools\. The tools teammate can use: demo: time/);
    assert.deepEqual(parseDelegations("@tools: what time is it"), [{ agent: "tools", task: "what time is it" }]);
    assert.equal((await routeTask(script([{ agent: "tools", reason: "tool" }]), "m", "what time is it")).agent, "tools");
  } finally {
    setToolsSummary(null);
  }
});
