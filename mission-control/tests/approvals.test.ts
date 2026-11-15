// Tests for approvals (Phase 4).   npm test
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { ApprovalCenter, ApprovalPolicySchema, isHighRisk, isSensitiveField } from "../src/hq/approvals";
import type { ActionRequest, Approval } from "../src/hq/approvals";
import { routineFields, routinePatchError } from "../src/hq/routine";
import { saveNotes } from "../src/hq/team";
import { TelegramBot } from "../src/hq/telegram";

const req = (over: Partial<ActionRequest> = {}): ActionRequest => ({ kind: "type", target: "Name", text: "Ada", url: "https://shop.example/form", site: "shop.example", ...over });
const ctx = (over: Partial<{ taskId: string; unattended: boolean; signal: AbortSignal }> = {}) => ({ taskId: "t1", taskTitle: "Fill the form", agent: "browser", unattended: false, ...over });

function center() {
  const requests: Approval[] = [];
  const decisions: Approval[] = [];
  const c = new ApprovalCenter({ onRequest: (a) => requests.push(a), onDecision: (a) => decisions.push({ ...a }) });
  return { c, requests, decisions };
}

test("asking: the action waits until the user answers", async () => {
  const { c, requests, decisions } = center();
  const pending = c.check(req(), ctx());
  await new Promise((r) => setImmediate(r));
  assert.equal(requests.length, 1);
  assert.equal(c.pending().length, 1);
  assert.match(requests[0].code, /^[a-f0-9]{6}$/);
  assert.equal(c.decide(requests[0].code, true, "telegram"), true, "answers by short code too");
  assert.equal(await pending, null);
  assert.equal(decisions.at(-1)!.status, "approved");
  assert.equal(decisions.at(-1)!.decidedBy, "telegram");
  assert.equal(c.decide(requests[0].id, false), false, "a request is answered once");
  // Denied, with a note the agent sees
  const second = c.check(req({ text: "Bob" }), ctx());
  await new Promise((r) => setImmediate(r));
  c.decide(requests[1].id, false, "you", "once", "wrong name");
  assert.equal(await second, "the user declined: wrong name");
});

test("settings: allow goes ahead, block refuses, both are recorded", async () => {
  const { c, requests, decisions } = center();
  c.policy = ApprovalPolicySchema.parse({ type: "allow", click: "block" });
  assert.equal(await c.check(req(), ctx()), null);
  assert.equal(await c.check(req({ kind: "click", target: "Next" }), ctx()), "blocked by your approval settings");
  assert.equal(requests.length, 0, "nothing waited");
  assert.deepEqual(decisions.map((d) => [d.status, d.decidedBy]), [["approved", "policy"], ["denied", "policy"]]);
  // Searches are allowed by default
  assert.equal(ApprovalPolicySchema.parse({}).search, "allow");
});

test("“this card, this site” covers the same kind of action on the same site only", async () => {
  const { c, requests } = center();
  const first = c.check(req(), ctx());
  await new Promise((r) => setImmediate(r));
  c.decide(requests[0].id, true, "you", "card");
  assert.equal(await first, null);
  assert.equal(await c.check(req({ target: "Email", text: "a@b.c" }), ctx()), null, "same card, site and kind: no question");
  assert.equal(requests.length, 1);
  const otherSite = c.check(req({ site: "bank.example" }), ctx());
  const otherCard = c.check(req(), ctx({ taskId: "t2" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(requests.length, 3, "another site or card asks again");
  c.endTask("t1");
  c.endTask("t2");
  assert.equal(await otherSite, "the run was stopped");
  assert.equal(await otherCard, "the run was stopped");
  // The grant ended with the card
  const again = c.check(req(), ctx());
  await new Promise((r) => setImmediate(r));
  assert.equal(c.pending().length, 1);
  c.endTask("t1");
  await again;
});

test("high-risk clicks and unattended runs always ask", async () => {
  const { c, requests } = center();
  c.policy = ApprovalPolicySchema.parse({ click: "allow", submit: "allow", type: "allow" });
  assert.equal(await c.check(req({ kind: "click", target: "Next page" }), ctx()), null);
  const buy = c.check(req({ kind: "click", target: "Place your order" }), ctx());
  const routine = c.check(req(), ctx({ unattended: true }));
  await new Promise((r) => setImmediate(r));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].risk, "high");
  // A card-wide approval doesn't cover high-risk actions
  c.decide(requests[0].id, true, "you", "card");
  assert.equal(await buy, null);
  const buyAgain = c.check(req({ kind: "click", target: "Place your order" }), ctx());
  await new Promise((r) => setImmediate(r));
  assert.equal(requests.length, 3);
  c.endTask("t1");
  await Promise.all([buyAgain, routine]);
  assert.equal(isHighRisk("click", "Delete account"), true);
  assert.equal(isHighRisk("click", "Show more"), false);
  assert.equal(isHighRisk("type", "Buy"), false);
});

test("no answer in time counts as denied; stopping the run cancels the request", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { c, decisions } = center();
    c.policy = ApprovalPolicySchema.parse({ timeoutMinutes: 2 });
    const waiting = c.check(req(), ctx());
    await Promise.resolve();
    mock.timers.tick(2 * 60_000 + 10);
    assert.equal(await waiting, "nobody answered within 2 minutes");
    assert.equal(decisions.at(-1)!.status, "expired");
  } finally {
    mock.timers.reset();
  }
  const { c } = center();
  const stop = new AbortController();
  const waiting = c.check(req(), ctx({ signal: stop.signal }));
  await new Promise((r) => setImmediate(r));
  stop.abort();
  assert.equal(await waiting, "the run was stopped");
  assert.equal(c.pending().length, 0);
});

test("password, payment, bank, ID and one-time-code fields are recognised", () => {
  for (const f of [
    { type: "password" },
    { autocomplete: "cc-number" },
    { autocomplete: "one-time-code" },
    { label: "Card number" },
    { label: "CVV" },
    { name: "iban" },
    { label: "Social Security Number" },
    { label: "Enter the verification code we texted you" },
    { name: "pin" },
  ])
    assert.equal(isSensitiveField(f), true, JSON.stringify(f));
  for (const f of [{ label: "Search" }, { label: "Your name", name: "name" }, { label: "Email" }, { label: "Spinach quantity", name: "spinach" }]) assert.equal(isSensitiveField(f), false, JSON.stringify(f));
});

test("routines: read-only unless the routine may act; a card can't switch itself", () => {
  const env = { vault: "/v" };
  assert.deepEqual(routineFields({ source: "routine" }, env), { readOnly: true, deliverTo: "dashboard", chatId: undefined });
  assert.deepEqual(routineFields({ source: "routine" }, env, true), { readOnly: false, deliverTo: "dashboard", chatId: undefined });
  assert.match(routinePatchError({ source: "routine" }, { readOnly: false })!, /May act/);
});

test("vault notes never overwrite each other", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "vault-"));
  saveNotes(vault, '<note title="Plan">one</note>');
  saveNotes(vault, '<note title="Plan">two</note>');
  const files = readdirSync(path.join(vault, "HQ", "inbox"));
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => /Plan \(2\)\.md$/.test(f)), files.join(", "));
});

test("Telegram: buttons and /approve only work from allowed chats", async () => {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: String(url).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, result: [] }));
  }) as typeof fetch;
  try {
    const decided: string[] = [];
    const bot = new TelegramBot("TOKEN", new Set(["42"]), {
      submit: () => ({ taskId: "x" }),
      queueText: () => "",
      log: () => {},
      decide: (code, approve, scope) => (decided.push(`${code}:${approve}:${scope}`), code === "abc123"),
      pendingText: () => "abc123: type “x”",
    });
    await bot.sendApproval("42", "Browser wants to type", "abc123", true);
    const keyboard = (sent[0].body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0].map((b) => b.callback_data);
    assert.deepEqual(keyboard, ["ap:abc123:once", "ap:abc123:card", "ap:abc123:deny"]);
    await bot.handleCallback({ id: "q1", data: "ap:abc123:card", message: { message_id: 7, chat: { id: 42 } } });
    await bot.handleCallback({ id: "q2", data: "ap:abc123:once", message: { message_id: 8, chat: { id: 99 } } });
    await bot.handle({ chat: { id: 42 }, text: "/deny abc123" });
    await bot.handle({ chat: { id: 42 }, text: "/approvals" });
    assert.deepEqual(decided, ["abc123:true:card", "abc123:false:once"], "the stranger's button press did nothing");
    assert.ok(sent.some((s) => s.method === "sendMessage" && s.body.text === "abc123: type “x”"));
    assert.ok(sent.some((s) => s.method === "answerCallbackQuery" && s.body.text === "Not allowed"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
