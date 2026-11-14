// Tests for replying to cards.   npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskReplySchema } from "../src/schemas/agent";
import { HISTORY_CHARS, HISTORY_TURNS, THREAD_KEEP, closeRound, historyMessages } from "../src/hq/thread";
import { resolvePrivate } from "../src/hq/privacy";
import type { Task } from "../src/hq/taskstore";

const card = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  prompt: "Give me 5 types of coffee report",
  targetAgent: "file",
  source: "ui",
  model: "ollama/gemma4:26b",
  status: "complete",
  createdAt: 1,
  startedAt: 2,
  finishedAt: 3,
  requestedAgent: "auto",
  events: [],
  answer: "Which directory should I scan?",
  ...over,
});

test("a reply closes the round: question and answer join the thread", () => {
  const t1 = card({ usedPrivate: true, privateNotes: "Transcript of the attached audio:\nhello" });
  const thread = closeRound(t1);
  assert.deepEqual(
    thread.map((t) => [t.role, t.text, t.agent, t.private]),
    [
      ["user", "Give me 5 types of coffee report", undefined, undefined],
      ["agent", "Which directory should I scan?", "file", true],
    ],
  );
  assert.match(thread[0].notes!, /hello/);
  // The next round's question is the reply, not the original prompt
  const t2 = card({ thread, reply: "Use the browser instead", answer: undefined, error: "fetch failed" });
  const next = closeRound(t2);
  assert.equal(next.length, 4);
  assert.equal(next[2].text, "Use the browser instead");
  assert.equal(next[3].text, "(The run failed: fetch failed)");
});

test("the thread keeps whole rounds and always starts with the user", () => {
  let t = card();
  for (let i = 0; i < 30; i++) t = card({ thread: closeRound(t), reply: `reply ${i}` });
  assert.equal(t.thread!.length, THREAD_KEEP);
  assert.equal(t.thread![0].role, "user");
});

test("history: private turns and attachment notes are withheld from cloud models", () => {
  const thread = closeRound(card({ usedPrivate: true, answer: "Your vault says SECRET-42", privateNotes: "picture shows a PIN 9911" }));
  const msgs = historyMessages(thread);
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
  const cloud = msgs.map((m) => resolvePrivate(m.content, false).text).join("\n");
  assert.ok(!cloud.includes("SECRET-42") && !cloud.includes("9911"), cloud);
  assert.ok(cloud.includes("Give me 5 types of coffee report"), "the user's own words still go");
  assert.match(cloud, /withheld from cloud models/);
  const local = msgs.map((m) => resolvePrivate(m.content, true).text).join("\n");
  assert.ok(local.includes("SECRET-42") && local.includes("9911"));
});

test("history is limited in turns and length, and cutting never opens a private block", () => {
  let t = card({ answer: "x".repeat(HISTORY_CHARS * 2), usedPrivate: true });
  for (let i = 0; i < 10; i++) t = card({ thread: closeRound(t), reply: `r${i}`, answer: "y".repeat(HISTORY_CHARS * 2), usedPrivate: true });
  const msgs = historyMessages(t.thread);
  assert.equal(msgs.length, HISTORY_TURNS);
  for (const m of msgs.filter((x) => x.role === "assistant")) {
    assert.ok(m.content.length < HISTORY_CHARS + 400);
    assert.ok(!resolvePrivate(m.content, false).text.includes("yyyy"));
  }
});

test("reply input: defaults to the same agent; empty messages are refused", () => {
  assert.deepEqual(TaskReplySchema.parse({ message: " use the browser " }), { message: "use the browser", images: [], audio: [], targetAgent: "same" });
  assert.equal(TaskReplySchema.safeParse({ message: "   " }).success, false);
  assert.equal(TaskReplySchema.parse({ message: "x", targetAgent: "browser" }).targetAgent, "browser");
  assert.equal(TaskReplySchema.safeParse({ message: "x", targetAgent: "audio" }).success, false);
});
