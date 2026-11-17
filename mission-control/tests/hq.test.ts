// Unit tests for the HQ modules. No Ollama needed.   npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedReason, searchResultTarget } from "../src/hq/browser";
import { StreamGuard, redact } from "../src/hq/guard";
import { Hive } from "../src/hq/hive";
import { Memory, similarity } from "../src/hq/memory";
import { parseJsonLoose } from "../src/hq/ollama";
import type { JsonChat } from "../src/hq/ollama";
import { keywordRoute, parseDelegations, routeTask, synthesisPrompt, teamContext, withLiveContext } from "../src/hq/team";
import { TelegramBot } from "../src/hq/telegram";

const fakeChat =
  (reply: Record<string, unknown> | Error): JsonChat =>
  async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  };

test("delegation lines are parsed and invalid agents ignored", () => {
  const text = [
    "I'll split this up.",
    "@browser: Find a free weather API with no key",
    "- @coder: Write a Python CLI that prints today's forecast",
    "@planner: should be ignored (no self-delegation)",
    "@nobody: unknown agent",
    "@security_audit: Review the API key handling",
  ].join("\n");
  assert.deepEqual(
    parseDelegations(text).map((d) => d.agent),
    ["browser", "coder", "security_audit"],
  );
  assert.deepEqual(parseDelegations("Just a normal answer with an email a@b.com"), []);
});

test("synthesis prompt carries every teammate result", () => {
  const p = synthesisPrompt("make an app", [
    { agent: "browser", task: "find api", output: "Open-Meteo" },
    { agent: "coder", task: "write code", output: "print(1)" },
  ]);
  assert.match(p, /Open-Meteo/);
  assert.match(p, /print\(1\)/);
});

test("team context lists teammates but not the agent itself", () => {
  const ctx = teamContext("coder");
  assert.match(ctx, /planner: Jarvis/);
  assert.doesNotMatch(ctx, /- coder:/);
});

test("system context stays identical between calls; live context goes with the request", () => {
  assert.equal(teamContext("planner", "vault note"), teamContext("planner", "vault note"));
  assert.doesNotMatch(teamContext("planner"), /HIVE MIND|MEMORIES/);
  const msg = withLiveContext("make an app", { hive: "planner delegated: x", memories: ["likes TypeScript"] });
  assert.match(msg, /HIVE MIND[\s\S]*likes TypeScript[\s\S]*REQUEST:\nmake an app$/);
});

test("router uses the model, then falls back to keywords", async () => {
  assert.equal((await routeTask(fakeChat({ agent: "security_audit", reason: "ports" }), "m", "x")).agent, "security_audit");
  const fallback = await routeTask(fakeChat(new Error("ollama down")), "m", "fix this python bug");
  assert.deepEqual(fallback, { agent: "coder", reason: "keyword match" });
  assert.equal((await routeTask(fakeChat({ agent: "nonsense" }), "m", "hello there")).agent, "planner");
  assert.equal(keywordRoute("harden my firewall"), "security_audit");
});

test("loose JSON parsing survives think tags and prose", () => {
  assert.deepEqual(parseJsonLoose('<think>hmm</think>Sure: {"agent":"coder"} done'), { agent: "coder" });
  assert.deepEqual(parseJsonLoose("not json"), {});
});

test("guard redacts secrets", () => {
  const { text, found } = redact(`key sk-ant-${"a".repeat(30)} token ghp_${"b".repeat(36)} password=hunter2hunter2`);
  assert.doesNotMatch(text, /sk-ant-a|ghp_b|hunter2/);
  assert.deepEqual(new Set(found), new Set(["anthropic key", "github token", "password assignment"]));
  assert.equal(redact("nothing to see").text, "nothing to see");
});

test("stream guard catches a secret split across chunks", () => {
  const g = new StreamGuard(40);
  const secret = `sk-ant-${"x".repeat(30)}`;
  const chunks = ["Here is the key: ", secret.slice(0, 12), secret.slice(12), " and some more words after it to flush the buffer properly."];
  const out = chunks.map((c) => g.push(c)).join("") + g.end();
  assert.doesNotMatch(out, /sk-ant-x/);
  assert.match(out, /\[REDACTED anthropic key\]/);
  assert.match(out, /flush the buffer properly\.$/);
});

test("hive keeps a rolling log", () => {
  const hive = new Hive(":memory:");
  hive.log("planner", "delegated", "→ coder: write code", "t1");
  hive.log("coder", "finished", "done");
  assert.equal(hive.recent(10).length, 2);
  assert.match(hive.promptText(), /planner delegated: → coder: write code/);
  hive.log("coder", "finished", `token=${"z".repeat(20)}`);
  assert.doesNotMatch(hive.promptText(), /zzzz/);
});

test("memory extracts, recalls, merges and decays", async () => {
  const mem = new Memory(":memory:", fakeChat({ memories: [{ text: "User runs qwen3:14b on an RX 9060 XT", importance: 0.8, shared: true }] }), "m");
  assert.deepEqual(await mem.extract("planner", "what gpu", "RX 9060 XT"), ["User runs qwen3:14b on an RX 9060 XT"]);
  assert.deepEqual(await mem.recall("which qwen3 model on my gpu", "coder"), ["User runs qwen3:14b on an RX 9060 XT"]);
  // Facts from an exchange that used no private material may go to the cloud
  assert.equal((await mem.list())[0].private, false);

  const a = await mem.add("The user prefers Python for scripts");
  assert.equal(await mem.add("The user prefers Python for scripts."), a);
  assert.ok(similarity("abc def", "abc def") === 1);

  await mem.add("Old trivia about a cafe menu", "shared", 0.3);
  await mem.add("Home lab is Proxmox at 192.168.4.90", "shared", 0.3, true);
  const stats = await mem.maintain(Date.now() + 60 * 86_400_000);
  assert.ok(stats.forgotten >= 1);
  const texts = (await mem.list()).map((m) => m.text);
  assert.ok(texts.includes("Home lab is Proxmox at 192.168.4.90"));
  assert.ok(!texts.includes("Old trivia about a cafe menu"));
});

test("telegram rejects strangers and queues allowed chats", async () => {
  const submitted: string[][] = [];
  const sent: string[] = [];
  const bot = new TelegramBot("t", new Set(["42"]), {
    submit: (prompt, agent, chatId) => {
      submitted.push([prompt, agent, chatId]);
      return { taskId: "abcdef123456" };
    },
    queueText: () => "Queue is empty.",
    log: () => {},
  });
  bot.send = async (_chat: string, text: string) => {
    sent.push(text);
  };
  await bot.handle({ chat: { id: 7 }, text: "run something" });
  assert.equal(submitted.length, 0);
  assert.match(sent[0], /chat ID is 7/);
  await bot.handle({ chat: { id: 42 }, text: "/coder write a regex" });
  assert.deepEqual(submitted[0], ["write a regex", "coder", "42"]);
  await bot.handle({ chat: { id: 42 }, text: "hello" });
  assert.equal(submitted[1][1], "auto");
});

test("browser guard blocks local and private addresses", async () => {
  for (const url of ["http://127.0.0.1:3008/api/system", "http://192.168.4.90/", "http://10.0.0.1/", "http://localhost/", "http://[::1]/", "http://router.local/"]) {
    assert.ok(await blockedReason(url), `${url} should be blocked`);
  }
  assert.match((await blockedReason("file:///etc/passwd"))!, /not allowed/);
  assert.equal(await blockedReason("https://1.1.1.1/"), null);
  assert.equal(await blockedReason("http://127.0.0.1:8765/", true), null);
});

test("search result links are judged by where they lead", () => {
  assert.equal(searchResultTarget("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews%3Fa%3D1&rut=abc"), "https://example.com/news?a=1");
  assert.equal(searchResultTarget("https://html.duckduckgo.com/html/?q=news"), null);
  assert.equal(searchResultTarget("https://example.com/l/?uddg=https%3A%2F%2Fevil.test"), null);
  assert.equal(searchResultTarget("https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)"), null);
  assert.equal(searchResultTarget("not a url"), null);
});
