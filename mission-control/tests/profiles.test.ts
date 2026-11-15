// Tests for browser profiles and taking over (Phase 5).   npm test
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { Profiles, toCdpCookies } from "../src/hq/profiles";
import type { StoredCookie } from "../src/hq/profiles";
import { BrowserControl } from "../src/hq/takeover";

const cookie = (over: Partial<StoredCookie> = {}): StoredCookie => ({ name: "sid", value: "s3cret-session", domain: ".shop.example", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true, ...over });

test("profiles keep sign-ins between runs, without expired cookies", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "prof-"));
  const p = new Profiles(dir, "");
  assert.equal(p.create("main"), null);
  assert.match(p.create("main")!, /already exists/);
  assert.match(p.create("Bad Name!")!, /lowercase/);
  p.save("main", [cookie(), cookie({ name: "old", expires: Date.now() / 1000 - 10 }), cookie({ name: "tab", session: true, expires: -1 })]);
  assert.deepEqual(
    p.cookies("main").map((c) => c.name),
    ["sid", "tab"],
  );
  const info = p.info("main")!;
  assert.deepEqual([info.cookies, info.sites, info.encrypted], [2, ["shop.example"], false]);
  if (process.platform !== "win32") assert.equal(statSync(path.join(dir, "main.json")).mode & 0o777, 0o600, "readable by you only");
  assert.deepEqual(p.list().map((x) => x.name), ["main"]);
  assert.equal(p.remove("main"), true);
  assert.equal(p.exists("main"), false);
  assert.equal(p.cookies("../../etc/passwd").length, 0);
});

test("with PROFILE_SECRET, sign-ins are encrypted at rest", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "prof-"));
  const p = new Profiles(dir, "correct horse");
  p.create("bank");
  p.save("bank", [cookie()]);
  const raw = readFileSync(path.join(dir, "bank.json"), "utf8");
  assert.ok(!raw.includes("s3cret-session"), "the cookie value isn't on disk in plain text");
  assert.equal(p.cookies("bank")[0].value, "s3cret-session");
  assert.equal(p.info("bank")!.encrypted, true);
  assert.throws(() => new Profiles(dir, "wrong").cookies("bank"), /PROFILE_SECRET has changed/);
  assert.throws(() => new Profiles(dir, "").cookies("bank"), /is encrypted/);
});

test("cookies convert to what Chrome accepts", () => {
  const [c, s] = toCdpCookies([cookie({ sameSite: "Lax" }), cookie({ name: "tab", session: true, expires: -1 })]);
  assert.equal(c.sameSite, "Lax");
  assert.ok("expires" in c);
  assert.ok(!("expires" in s), "session cookies have no expiry");
});

test("taking over: the agent waits until the browser is handed back", async () => {
  const changes: string[] = [];
  const c = new BrowserControl((x) => changes.push(`${x.state}:${x.requestedBy ?? ""}`));
  assert.equal(await c.waitForAgent(undefined, 1000), "returned", "no wait when the agent has control");
  c.takeOver("agent", "Please sign in to the shop");
  assert.equal(c.reason, "Please sign in to the shop");
  const waiting = c.waitForAgent(undefined, 60_000);
  c.handBack();
  assert.equal(await waiting, "returned");
  assert.deepEqual(changes, ["user:agent", "agent:"]);
});

test("taking over: control comes back by itself after the time limit, and a stopped run stops waiting", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const c = new BrowserControl();
    c.takeOver("user");
    const waiting = c.waitForAgent(undefined, 30 * 60_000);
    mock.timers.tick(30 * 60_000 + 1);
    assert.equal(await waiting, "timeout");
    assert.equal(c.state, "agent");
  } finally {
    mock.timers.reset();
  }
  const c = new BrowserControl();
  c.takeOver("user");
  const stop = new AbortController();
  const waiting = c.waitForAgent(stop.signal, 60_000);
  stop.abort();
  assert.equal(await waiting, "aborted");
});
