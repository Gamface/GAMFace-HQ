// Tests for the Decision Inbox and Plan Markup.   npm test
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { QuestionStore, answerMessage, parseAsks, readyToDeliver } from "../src/hq/inbox";
import { applyAnnotations, blockText, cleanAnnotations, planBlocks, reviewMessage } from "../src/hq/plans";
import type { PlanAnnotation } from "../src/hq/plans";
import { boardColumn } from "../src/schemas/agent";
import { dependenciesMet } from "../src/hq/taskstore";
import type { Task } from "../src/hq/taskstore";

// --- Questions ---------------------------------------------------------------------

test("questions are taken out of an answer, with their options", () => {
  const out = parseAsks(
    'Built the page with Tailwind.\n\n<ask options="Postgres | SQLite|Postgres">Which database?</ask>\n<ask>Any brand colours?</ask>\n<ask options="a|b">A third one is dropped</ask>',
  );
  assert.equal(out.text, "Built the page with Tailwind.");
  assert.deepEqual(out.asks, [
    { question: "Which database?", options: ["Postgres", "SQLite"] },
    { question: "Any brand colours?", options: [] },
  ]);
  // A single option isn't a choice: it becomes an open question
  assert.deepEqual(parseAsks('<ask options="Yes">Go ahead?</ask>').asks[0].options, []);
  assert.deepEqual(parseAsks("No questions here.").asks, []);
  assert.deepEqual(parseAsks("<ask>   </ask>").asks, [], "empty questions are ignored");
});

function questionStore() {
  let now = 1000;
  const store = new QuestionStore(new DatabaseSync(":memory:"), () => now++);
  return store;
}

test("answering: a card gets its answers once every question it asked is settled", () => {
  const qs = questionStore();
  const [a, b] = qs.post({ id: "t1", title: "Landing page", agent: "coder" }, [
    { question: "Which database?", options: ["Postgres", "SQLite"] },
    { question: "Dark mode?", options: ["Yes", "No"] },
  ]);
  assert.match(a.code, /^[a-f0-9]{6}$/);
  assert.equal(qs.open().length, 2);
  assert.ok(qs.answer(a.code, "SQLite", "keep it simple"), "answers by short code too");
  assert.equal(qs.answer(a.id, "Postgres"), null, "a question is answered once");
  assert.deepEqual(readyToDeliver(qs, "t1", true), [], "waits for the other question");
  assert.ok(qs.dismiss(b.id));
  const ready = readyToDeliver(qs, "t1", true);
  assert.deepEqual(ready.map((q) => q.answer), ["SQLite"]);
  assert.deepEqual(readyToDeliver(qs, "t1", false), [], "a running card gets them when it finishes");
  const msg = answerMessage(ready);
  assert.match(msg, /You asked: Which database\?\nMy answer: SQLite\nNote: keep it simple/);
  qs.markDelivered(ready.map((q) => q.id));
  assert.deepEqual(readyToDeliver(qs, "t1", true), [], "delivered once");
  assert.equal(qs.recent().length, 2);
});

test("a card's new questions replace its old open ones; removing the card drops them", () => {
  const qs = questionStore();
  qs.post({ id: "t1", title: "x", agent: "planner" }, [{ question: "Old?", options: [] }]);
  qs.post({ id: "t1", title: "x", agent: "planner" }, [{ question: "New?", options: [] }]);
  assert.deepEqual(qs.open("t1").map((q) => q.question), ["New?"]);
  qs.post({ id: "t2", title: "y", agent: "planner" }, [{ question: "Other card?", options: [] }]);
  qs.dropTask("t1");
  assert.deepEqual(qs.open().map((q) => q.taskId), ["t2"]);
});

// --- Plans -------------------------------------------------------------------------

const PLAN = `Goal: a booking page for the salon.

## Steps
1. Coder builds the form in web/book.html
2. Browser checks the calendar API docs
   for rate limits
3. File saves a note to the vault

## Risks
- The API may need a paid plan

\`\`\`sh
npm run build
\`\`\``;

test("a plan splits into headings, list items, paragraphs and code", () => {
  const blocks = planBlocks(PLAN);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["paragraph", "heading", "list", "list", "list", "heading", "list", "code"],
  );
  assert.equal(blockText(blocks[1]), "Steps");
  assert.equal(blockText(blocks[3]), "Browser checks the calendar API docs\n   for rate limits", "wrapped lines stay with their item");
  assert.equal(blocks[7].raw, "```sh\nnpm run build\n```");
  for (const b of blocks) assert.equal(PLAN.slice(b.start, b.start + b.raw.length), b.raw, "offsets point into the plan");
});

test("cuts and replacements are applied; comments leave the text alone", () => {
  const blocks = planBlocks(PLAN);
  const id = (i: number) => blocks[i].id;
  const marks: PlanAnnotation[] = [
    { blockId: id(4), quote: blocks[4].raw, kind: "delete" },
    { blockId: id(2), quote: "web/book.html", kind: "replace", text: "web/booking.html" },
    { blockId: id(6), quote: "paid plan", kind: "comment", text: "We already pay for it" },
  ];
  const out = applyAnnotations(PLAN, marks);
  assert.match(out, /1\. Coder builds the form in web\/booking\.html/);
  assert.doesNotMatch(out, /File saves a note/);
  assert.match(out, /paid plan/);
  assert.doesNotMatch(out, /\n{3,}/);
  // Overlapping edits: the first one wins
  const twice = applyAnnotations(PLAN, [
    { blockId: id(2), quote: "Coder builds the form", kind: "replace", text: "Forge builds it" },
    { blockId: id(2), quote: "the form", kind: "delete" },
  ]);
  assert.match(twice, /Forge builds it in web\/book\.html/);
});

test("markup that no longer matches the plan is dropped", () => {
  const blocks = planBlocks(PLAN);
  const kept = cleanAnnotations(PLAN, [
    { blockId: blocks[2].id, quote: "Coder", kind: "comment", text: "use Forge" },
    { blockId: blocks[2].id, quote: "not in this block", kind: "delete" },
    { blockId: "b99", quote: "Coder", kind: "delete" },
    { blockId: blocks[2].id, quote: "Coder", kind: "comment", text: "   " },
    { blockId: blocks[2].id, quote: "Coder", kind: "bogus" as never },
  ]);
  assert.equal(kept.length, 1);
});

test("the review message: approve carries the edited plan, revise carries the markup", () => {
  const blocks = planBlocks(PLAN);
  const marks: PlanAnnotation[] = [
    { blockId: blocks[4].id, quote: blocks[4].raw, kind: "delete" },
    { blockId: blocks[2].id, quote: "Coder", kind: "comment", text: "Use the React template" },
  ];
  const approve = reviewMessage(PLAN, marks, "approve", "Ship by Friday");
  assert.match(approve, /^I approved the plan/);
  assert.match(approve, /THE APPROVED PLAN:\nGoal: a booking page/);
  assert.doesNotMatch(approve, /File saves a note/);
  assert.match(approve, /MY COMMENTS:\n- On “Coder”: Use the React template/);
  assert.match(approve, /My note: Ship by Friday/);
  const revise = reviewMessage(PLAN, marks, "revise");
  assert.match(revise, /^Revise the plan\. Don't start the work yet/);
  assert.match(revise, /- Cut: “3\. File saves a note to the vault”/);
  assert.match(revise, /whole revised plan/);
});

test("a plan waiting for review sits in Review and holds back cards that depend on it", () => {
  assert.equal(boardColumn({ status: "complete", plan: { status: "awaiting", version: 1, text: "", at: 0 } }), "review");
  assert.equal(boardColumn({ status: "complete", plan: { status: "approved", version: 1, text: "", at: 0 } }), "done");
  const card = (over: Partial<Task>): Task => ({ id: "x", prompt: "p", targetAgent: "planner", source: "ui", model: "", status: "complete", createdAt: 0, events: [], requestedAgent: "planner", ...over });
  const all = new Map<string, Task>();
  all.set("plan", card({ id: "plan", planFirst: true, plan: { status: "awaiting", version: 1, text: "", at: 0 } }));
  const next = card({ id: "next", status: "queued", dependsOn: ["plan"] });
  assert.equal(dependenciesMet(next, all), false);
  all.get("plan")!.plan!.status = "approved";
  assert.equal(dependenciesMet(next, all), true);
});
