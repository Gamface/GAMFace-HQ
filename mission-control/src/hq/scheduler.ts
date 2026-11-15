// The routine scheduler. Each routine is a request plus a schedule; when it's due, the
// scheduler creates a card with source "routine", which the server always runs
// read-only and delivers to the routine's one destination (see routine.ts).
//
// Guards:
//   - a routine never overlaps itself: if its last card is still queued or running,
//     the run is skipped (and the routine says why)
//   - schedules can't run more often than every ROUTINE_MIN_MINUTES (default 5)
//   - runs missed while Mission Control was off or the PC slept are skipped, unless the
//     routine asks to catch up, and then it runs once, not once per missed time

import crypto from "node:crypto";
import { RoutineInputSchema, RoutinePatchSchema } from "../schemas/agent";
import type { Routine, RoutineInput } from "../schemas/agent";
import { nextRun, parseSchedule, shortestGapMinutes, validTimeZone } from "./schedule";
import type { TaskStore } from "./taskstore";

export const MAX_ROUTINES = 50;
// A run more than this late counts as missed (the PC was off or asleep)
const LATE_MS = 10 * 60_000;

export interface SchedulerHooks {
  /** Creates the routine's card; returns its id, or why it couldn't. */
  start(r: Routine): { taskId: string } | { error: string };
  /** Whether a card is still queued or running. */
  busy(taskId: string): boolean;
  /** Checks a destination can be used (Telegram or Obsidian set up). */
  checkDelivery(r: RoutineInput): string | null;
  /** Something the user should hear about (a skipped or failed run). */
  note(r: Routine, message: string): void;
}

export interface SchedulerOptions {
  defaultTimezone: string;
  minMinutes: number;
  now?: () => number;
}

const flat = (e: unknown) => {
  const f = (e as { flatten?: () => { fieldErrors: Record<string, string[]>; formErrors: string[] } }).flatten?.();
  if (!f) return String(e);
  const field = Object.entries(f.fieldErrors)[0];
  return field ? `${field[0]}: ${field[1][0]}` : f.formErrors[0] ?? "invalid routine";
};

export class Scheduler {
  private routines = new Map<string, Routine>();
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;

  constructor(
    private store: TaskStore,
    private hooks: SchedulerHooks,
    private opts: SchedulerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    for (const r of store.routines()) this.routines.set(r.id, r);
  }

  list(): Routine[] {
    return [...this.routines.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Routine | undefined {
    return this.routines.get(id);
  }

  /** Validates a routine and works out its schedule. */
  private build(input: RoutineInput, prev?: Routine): Routine | { error: string } {
    const timezone = input.timezone ?? prev?.timezone ?? this.opts.defaultTimezone;
    if (!validTimeZone(timezone)) return { error: `Unknown time zone "${timezone}"` };
    let parsed;
    try {
      parsed = parseSchedule(input.schedule);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    const gap = shortestGapMinutes(parsed.cron, timezone, this.now());
    if (gap < this.opts.minMinutes) return { error: `Routines can run at most every ${this.opts.minMinutes} minutes` };
    if (!Number.isFinite(gap) && nextRun(parsed.cron, this.now(), timezone) === null) return { error: "That schedule never comes round" };
    const delivery = this.hooks.checkDelivery(input);
    if (delivery) return { error: delivery };
    const now = this.now();
    return {
      ...prev,
      ...input,
      id: prev?.id ?? crypto.randomUUID(),
      timezone,
      cron: parsed.cron,
      label: parsed.label,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      runs: prev?.runs ?? 0,
      nextRunAt: input.enabled ? (nextRun(parsed.cron, now, timezone) ?? undefined) : undefined,
    };
  }

  create(raw: unknown): Routine | { error: string } {
    const parsed = RoutineInputSchema.safeParse(raw);
    if (!parsed.success) return { error: flat(parsed.error) };
    if (this.routines.size >= MAX_ROUTINES) return { error: `At most ${MAX_ROUTINES} routines` };
    const r = this.build(parsed.data);
    if ("error" in r) return r;
    this.routines.set(r.id, r);
    this.store.saveRoutine(r);
    return r;
  }

  update(id: string, raw: unknown): Routine | { error: string } {
    const prev = this.routines.get(id);
    if (!prev) return { error: "Routine not found" };
    const patch = RoutinePatchSchema.safeParse(raw);
    if (!patch.success) return { error: flat(patch.error) };
    const { id: _id, cron: _c, label: _l, createdAt: _ca, updatedAt: _u, nextRunAt: _n, lastRunAt: _lr, lastTaskId: _lt, lastStatus: _ls, lastSkip: _sk, runs: _r, ...current } = prev;
    const merged = RoutineInputSchema.safeParse({ ...current, ...patch.data });
    if (!merged.success) return { error: flat(merged.error) };
    const r = this.build(merged.data, prev);
    if ("error" in r) return r;
    this.routines.set(id, r);
    this.store.saveRoutine(r);
    return r;
  }

  remove(id: string): boolean {
    if (!this.routines.delete(id)) return false;
    this.store.deleteRoutine(id);
    return true;
  }

  /** Starts a run now, whatever the schedule says. */
  runNow(id: string): { taskId: string } | { error: string } {
    const r = this.routines.get(id);
    if (!r) return { error: "Routine not found" };
    return this.fire(r, "manual");
  }

  private fire(r: Routine, why: "schedule" | "manual" | "catch-up"): { taskId: string } | { error: string } {
    let out: { taskId: string } | { error: string };
    if (r.lastTaskId && this.hooks.busy(r.lastTaskId)) out = { error: "the previous run is still going" };
    else out = this.hooks.start(r);
    if ("error" in out) {
      r.lastSkip = out.error;
      if (why !== "manual") this.hooks.note(r, `Routine “${r.name}” didn't run: ${out.error}.`);
    } else {
      Object.assign(r, { lastTaskId: out.taskId, lastRunAt: this.now(), lastStatus: "queued", lastSkip: undefined, runs: r.runs + 1 });
    }
    this.store.saveRoutine(r);
    return out;
  }

  /** Runs every routine that is due. Called by the timer. */
  tick() {
    const now = this.now();
    for (const r of this.routines.values()) {
      if (!r.enabled || r.nextRunAt === undefined || r.nextRunAt > now) continue;
      const late = now - r.nextRunAt > LATE_MS;
      if (!late) this.fire(r, "schedule");
      else if (r.catchUp) this.fire(r, "catch-up");
      else {
        r.lastSkip = "missed while Mission Control was off or the PC was asleep";
        this.hooks.note(r, `Routine “${r.name}” missed its run at ${new Date(r.nextRunAt).toLocaleString("en-US", { timeZone: r.timezone })} (Mission Control was off or asleep).`);
      }
      // One run per due time, never a burst for every time that passed
      r.nextRunAt = nextRun(r.cron, now, r.timezone) ?? undefined;
      this.store.saveRoutine(r);
    }
  }

  /** Records how a routine's run ended. */
  finished(task: { id: string; routineId?: string; status: string }) {
    const r = task.routineId ? this.routines.get(task.routineId) : undefined;
    if (!r || r.lastTaskId !== task.id) return;
    r.lastStatus = task.status;
    this.store.saveRoutine(r);
  }

  start(intervalMs = 15_000) {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
