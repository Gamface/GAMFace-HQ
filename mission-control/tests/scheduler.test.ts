// Tests for routines: schedules and the scheduler.   npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRun, parseSchedule, upcoming } from "../src/hq/schedule";
import { Scheduler } from "../src/hq/scheduler";
import type { SchedulerHooks } from "../src/hq/scheduler";
import { TaskStore } from "../src/hq/taskstore";

const NY = "America/New_York";
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

test("plain-word schedules become cron", () => {
  const cases: [string, string][] = [
    ["weekdays at 7:30am", "30 7 * * 1-5"],
    ["Every 2 hours", "0 */2 * * *"],
    ["every 15 minutes", "*/15 * * * *"],
    ["hourly", "0 * * * *"],
    ["every hour at :30", "30 * * * *"],
    ["daily at 8pm", "0 20 * * *"],
    ["every day at noon", "0 12 * * *"],
    ["mondays at 9am", "0 9 * * 1"],
    ["mon, wed and fri at 6:15pm", "15 18 * * 1,3,5"],
    ["weekends at 10:00", "0 10 * * 0,6"],
    ["monthly on the 1st at 9:00", "0 9 1 * *"],
    ["30 7 * * 1-5", "30 7 * * 1-5"],
  ];
  for (const [input, cron] of cases) assert.equal(parseSchedule(input).cron, cron, input);
  assert.equal(parseSchedule("weekdays at 7:30am").label, "Weekdays at 7:30am");
  for (const bad of ["tomorrow", "every 0 minutes", "daily at 25:00", "61 * * * *", "monthly on the 31st"]) assert.throws(() => parseSchedule(bad), Error, bad);
});

test("next runs follow the time zone and daylight saving", () => {
  const sun = Date.parse("2026-11-15T19:11:00Z"); // Sunday 2:11pm in New York
  assert.equal(iso(nextRun("30 7 * * 1-5", sun, NY)), "2026-11-16T12:30:00.000Z"); // Mon 7:30 EST
  assert.equal(iso(nextRun("0 8 * * *", sun, "Asia/Tokyo")), "2026-11-15T23:00:00.000Z");
  // 2:30am doesn't exist on 14 March 2027 in New York: that day is skipped
  assert.deepEqual(upcoming("30 2 * * *", Date.parse("2027-03-13T12:00:00Z"), NY, 1).map(iso), ["2027-03-15T06:30:00.000Z"]);
  // 1:30am happens twice on 1 November 2026: it runs once
  assert.deepEqual(upcoming("30 1 * * *", Date.parse("2026-10-31T12:00:00Z"), NY, 2).map(iso), ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  // Day of month OR day of week when both are set (cron rule)
  assert.equal(iso(nextRun("0 9 13 * 5", Date.parse("2026-11-15T00:00:00Z"), "UTC")), "2026-11-20T09:00:00.000Z");
});

function setup(start = Date.parse("2026-11-16T12:00:00Z")) {
  let now = start;
  const store = new TaskStore(":memory:");
  const started: string[] = [];
  const notes: string[] = [];
  const running = new Set<string>();
  let n = 0;
  let deliveryError: string | null = null;
  const hooks: SchedulerHooks = {
    start: (r) => {
      const id = `card-${++n}`;
      started.push(`${r.name}:${id}`);
      running.add(id);
      return { taskId: id };
    },
    busy: (id) => running.has(id),
    checkDelivery: () => deliveryError,
    note: (_r, m) => notes.push(m),
  };
  const s = new Scheduler(store, hooks, { defaultTimezone: "UTC", minMinutes: 5, now: () => now });
  return {
    s,
    store,
    started,
    notes,
    running,
    advance: (ms: number) => (now += ms),
    setNow: (t: number) => (now = t),
    failDelivery: (e: string | null) => (deliveryError = e),
  };
}

test("routines are validated: schedule, minimum gap, time zone, destination", () => {
  const { s, failDelivery } = setup();
  assert.match((s.create({ name: "x", prompt: "y", schedule: "every 2 minutes" }) as { error: string }).error, /at most every 5 minutes/);
  assert.match((s.create({ name: "x", prompt: "y", schedule: "whenever" }) as { error: string }).error, /Try a schedule/);
  assert.match((s.create({ name: "x", prompt: "y", schedule: "hourly", timezone: "Mars/Olympus" }) as { error: string }).error, /Unknown time zone/);
  assert.match((s.create({ name: "", prompt: "y", schedule: "hourly" }) as { error: string }).error, /name/);
  failDelivery("Telegram isn't set up");
  assert.match((s.create({ name: "x", prompt: "y", schedule: "hourly", deliverTo: "telegram" }) as { error: string }).error, /Telegram/);
  failDelivery(null);
  const ok = s.create({ name: "News", prompt: "Summarize news.ycombinator.com", schedule: "every hour at :30", allowedSites: ["news.ycombinator.com"] });
  assert.ok(!("error" in ok));
  if ("error" in ok) return;
  assert.equal(ok.cron, "30 * * * *");
  assert.equal(ok.targetAgent, "auto");
  assert.equal(ok.deliverTo, "dashboard");
  assert.equal(iso(ok.nextRunAt ?? null), "2026-11-16T12:30:00.000Z");
});

test("due routines run once; a routine never overlaps itself", () => {
  const { s, started, notes, running, advance } = setup();
  const r = s.create({ name: "A", prompt: "p", schedule: "every 15 minutes" });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  s.tick();
  assert.deepEqual(started, [], "not due yet");
  advance(15 * 60_000);
  s.tick();
  s.tick();
  assert.deepEqual(started, ["A:card-1"], "one run per due time");
  advance(15 * 60_000);
  s.tick();
  assert.equal(started.length, 1, "skipped: the last run is still going");
  assert.match(notes[0], /previous run is still going/);
  assert.equal(s.get(r.id)?.lastSkip, "the previous run is still going");
  running.clear();
  s.finished({ id: "card-1", routineId: r.id, status: "complete" });
  advance(15 * 60_000);
  s.tick();
  assert.deepEqual(started, ["A:card-1", "A:card-2"]);
  assert.equal(s.get(r.id)?.runs, 2);
  assert.equal(s.get(r.id)?.lastStatus, "queued");
});

test("runs missed while off are skipped unless the routine catches up, and then only once", () => {
  const { s, started, notes, advance } = setup();
  const skip = s.create({ name: "Skip", prompt: "p", schedule: "hourly" }) as { id: string };
  const catchUp = s.create({ name: "Catch", prompt: "p", schedule: "hourly", catchUp: true }) as { id: string };
  advance(5 * 3600_000 + 60_000); // asleep for five hours
  s.tick();
  assert.deepEqual(started, ["Catch:card-1"], "one catch-up run, not five");
  assert.match(notes.join(" "), /“Skip” missed its run/);
  // Both are back on schedule: the next run is the coming hour
  assert.equal(iso(s.get(skip.id)!.nextRunAt!), "2026-11-16T18:00:00.000Z");
  assert.equal(iso(s.get(catchUp.id)!.nextRunAt!), "2026-11-16T18:00:00.000Z");
});

test("disabled routines don't run; Run now does; edits and restarts keep routines", () => {
  const { s, store, started, advance } = setup();
  const r = s.create({ name: "Daily", prompt: "p", schedule: "daily at 7am", enabled: false }) as { id: string; nextRunAt?: number };
  assert.equal(r.nextRunAt, undefined);
  advance(48 * 3600_000);
  s.tick();
  assert.deepEqual(started, []);
  assert.deepEqual(s.runNow(r.id), { taskId: "card-1" });
  const edited = s.update(r.id, { enabled: true, schedule: "weekdays at 6:45am", timezone: NY });
  assert.ok(!("error" in edited));
  if ("error" in edited) return;
  assert.equal(edited.cron, "45 6 * * 1-5");
  assert.equal(edited.runs, 1, "history survives an edit");
  assert.ok(edited.nextRunAt);
  assert.match((s.update(r.id, { schedule: "every minute" }) as { error: string }).error, /schedule/i);
  // A new scheduler on the same database finds the routine
  const again = new Scheduler(store, { start: () => ({ error: "x" }), busy: () => false, checkDelivery: () => null, note: () => {} }, { defaultTimezone: "UTC", minMinutes: 5 });
  assert.equal(again.get(r.id)?.label, "Weekdays at 6:45am");
  assert.equal(s.remove(r.id), true);
  assert.equal(s.get(r.id), undefined);
});
