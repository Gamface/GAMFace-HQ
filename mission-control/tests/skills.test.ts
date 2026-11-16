// Tests for skills and history search (Phase 6).   npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryIndex, Skills, keywords, skillDraftPrompt } from "../src/hq/skills";
import { TaskStore } from "../src/hq/taskstore";
import type { Task } from "../src/hq/taskstore";

const priceCheck = {
  name: "Compare product prices",
  description: "Find a product's price on several shops and compare them",
  agents: ["browser" as const],
  steps: "1. Search the product on each shop.\n2. Note price and shipping.\n3. Report a table, cheapest first.",
};

test("keywords skip common words and numbers", () => {
  assert.deepEqual(keywords("Please compare the price of the Sony WH-1000XM5 headphones on 3 shops"), ["compare", "price", "sony", "wh1000xm5", "headphones", "shops"]);
});

test("drafts do nothing until approved; skills you write are on at once", () => {
  const s = new Skills(new TaskStore(":memory:").sql);
  const draft = s.create(priceCheck, { sourceTaskId: "t1", sourceTitle: "Headphone prices" }) as { id: string; status: string };
  assert.equal(draft.status, "draft");
  assert.deepEqual(s.match("compare prices for these headphones across shops", "browser"), [], "a draft is never used");
  assert.equal(s.draftedFrom("t1"), true);
  const on = s.approve(draft.id) as { status: string };
  assert.equal(on.status, "active");
  assert.equal(s.match("compare prices for these headphones across shops", "browser")[0]?.name, "Compare product prices");
  assert.match((s.create({ ...priceCheck }, { status: "active" }) as { error: string }).error, /already a skill/);
  assert.match((s.create({ name: "x", description: "y", steps: "z" }) as { error: string }).error, /name/);
});

test("matching: the right agent, two shared words, only active skills", () => {
  const s = new Skills(new TaskStore(":memory:").sql);
  const sk = s.create(priceCheck, { status: "active" }) as { id: string };
  assert.equal(s.match("compare product prices on shops", "coder").length, 0, "another agent's skill");
  assert.equal(s.match("what's the price of milk", "browser").length, 0, "one shared word isn't enough");
  assert.equal(s.match("compare the prices of this product", "browser").length, 1);
  s.update(sk.id, { status: "off" });
  assert.equal(s.match("compare the prices of this product", "browser").length, 0, "switched off");
  const any = s.create({ name: "Write release notes", description: "Turn a list of changes into release notes for users", agents: [], steps: "1. Group changes.\n2. Write plainly." }, { status: "active" }) as { id: string };
  assert.equal(s.match("write the release notes for version 2", "coder")[0]?.id, any.id, "no agents listed: anyone may use it");
  s.recordUse(any.id);
  assert.equal(s.get(any.id)!.uses, 1);
});

test("a draft with an existing skill's name updates that skill when approved", () => {
  const s = new Skills(new TaskStore(":memory:").sql);
  const old = s.create(priceCheck, { status: "active" }) as { id: string };
  const draft = s.create({ ...priceCheck, steps: "1. Search each shop.\n2. Include shipping and tax.\n3. Table, cheapest first." }, { private: true }) as { id: string; replaces?: string };
  assert.equal(draft.replaces, old.id);
  const merged = s.approve(draft.id) as { id: string; steps: string; private: boolean };
  assert.equal(merged.id, old.id, "the same skill, updated");
  assert.match(merged.steps, /shipping and tax/);
  assert.equal(merged.private, true, "learned from private material, so it stays private");
  assert.equal(s.list().length, 1);
});

test("the draft prompt asks for general steps and allows no skill", () => {
  const p = skillDraftPrompt({ request: "Book a table", agents: ["browser"], answer: "Booked." });
  assert.match(p, /no one-off names, dates, numbers, links or personal details/);
  assert.match(p, /"skill": null/);
});

test("history search: words, prefixes, quoted phrases; highlighted snippets", () => {
  const h = new HistoryIndex(new TaskStore(":memory:").sql);
  h.put({ id: "a", title: "Weather app", prompt: "Build a weather CLI in Python", answer: "Use the Open-Meteo API: it needs no key." });
  h.put({ id: "b", title: "Coffee report", prompt: "Five types of coffee as a PDF", answer: "Espresso, latte, cappuccino…" });
  assert.deepEqual(h.search("weather").map((x) => x.taskId), ["a"]);
  assert.deepEqual(h.search("latt").map((x) => x.taskId), ["b"], "words match as prefixes");
  assert.deepEqual(h.search("cappu").map((x) => x.taskId), ["b"]);
  assert.deepEqual(h.search('"no key"').map((x) => x.taskId), ["a"]);
  assert.deepEqual(h.search('"key no"').map((x) => x.taskId), []);
  assert.match(h.search("meteo")[0].snippet, /«Meteo»/);
  h.put({ id: "a", title: "Weather app", prompt: "Build a weather CLI", answer: "Rewritten." });
  assert.equal(h.count(), 2, "re-indexing replaces");
  assert.deepEqual(h.search("meteo"), []);
  assert.deepEqual(h.search("   "), []);
  assert.deepEqual(h.search('"unclosed'), [], "odd input doesn't throw");
});

test("archived cards can still be opened and put back on the board", () => {
  const store = new TaskStore(":memory:");
  const t: Task = { id: "c1", prompt: "Old task", targetAgent: "planner", source: "ui", model: "m", status: "complete", createdAt: 1, events: [], answer: "done", requestedAgent: "planner" } as unknown as Task;
  store.add(t);
  store.archive("c1");
  assert.equal(store.tasks.has("c1"), false);
  assert.equal(store.find("c1")?.archived, true);
  assert.equal(store.find("c1")?.answer, "done");
  store.restore("c1");
  assert.equal(store.tasks.get("c1")?.answer, "done");
  assert.equal(store.find("c1")?.archived, undefined);
});
