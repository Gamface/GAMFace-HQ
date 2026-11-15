// Schedules for routines, in plain words or cron, worked out in the routine's time
// zone (daylight-saving changes included). No dependencies.
//
//   every 15 minutes · every 2 hours · hourly · every hour at :30
//   daily at 8am · every day at 18:30 · weekdays at 7:30am · weekends at 10:00
//   mondays at 9am · mon, wed and fri at 6pm · monthly on the 1st at 9:00
//   or five cron fields: "30 7 * * 1-5" (minute hour day-of-month month day-of-week)

export interface Cron {
  minutes: number[];
  hours: number[];
  days: number[]; // day of month, 1–31
  months: number[]; // 1–12
  weekdays: number[]; // 0 = Sunday
  anyDay: boolean; // day-of-month field was *
  anyWeekday: boolean; // day-of-week field was *
}

export interface ParsedSchedule {
  cron: string;
  label: string;
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function range(lo: number, hi: number, step = 1): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i += step) out.push(i);
  return out;
}

function parseField(field: string, lo: number, hi: number, names?: string[]): number[] {
  const values = new Set<number>();
  const num = (s: string) => {
    const n = names ? names.indexOf(s.toLowerCase().slice(0, 3)) : -1;
    const v = n >= 0 ? n + (lo === 1 ? 1 : 0) : Number(s);
    if (!Number.isInteger(v)) throw new Error(`"${s}" isn't a number`);
    return v;
  };
  for (const part of field.split(",")) {
    const [base, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step "${stepText}"`);
    let a: number;
    let b: number;
    if (base === "*") [a, b] = [lo, hi];
    else if (base.includes("-")) {
      const [x, y] = base.split("-");
      [a, b] = [num(x), num(y)];
    } else {
      a = num(base);
      b = stepText === undefined ? a : hi;
    }
    // Day of week: 7 means Sunday too
    if (hi === 6 && b === 7) {
      b = 6;
      values.add(0);
    }
    if (hi === 6 && a === 7) a = 0;
    if (a < lo || b > hi || a > b) throw new Error(`"${part}" is outside ${lo}–${hi}`);
    range(a, b, step).forEach((v) => values.add(v));
  }
  return [...values].sort((x, y) => x - y);
}

/** Parses five cron fields. Throws a readable error. */
export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("A cron schedule has five fields: minute hour day-of-month month day-of-week");
  return {
    minutes: parseField(f[0], 0, 59),
    hours: parseField(f[1], 0, 23),
    days: parseField(f[2], 1, 31),
    months: parseField(f[3], 1, 12, MONTH_NAMES),
    weekdays: parseField(f[4], 0, 6, DAY_NAMES),
    anyDay: f[2] === "*",
    anyWeekday: f[4] === "*",
  };
}

/** "8am", "8:30 pm", "20:15", "noon", "midnight" → [hour, minute] */
function parseTime(text: string): [number, number] {
  const t = text.trim().toLowerCase();
  if (t === "noon") return [12, 0];
  if (t === "midnight") return [0, 0];
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t);
  if (!m) throw new Error(`"${text}" isn't a time (try 8am, 7:30pm or 18:45)`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3]?.[0];
  if (ampm) {
    if (h < 1 || h > 12) throw new Error(`"${text}" isn't a time`);
    h = (h % 12) + (ampm === "p" ? 12 : 0);
  }
  if (h > 23 || min > 59) throw new Error(`"${text}" isn't a time`);
  return [h, min];
}

const clock = (h: number, m: number) => {
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
};

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** Turns a schedule in plain words (or cron) into cron plus a readable label. Throws a readable error. */
export function parseSchedule(input: string): ParsedSchedule {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ").replace(/^every day/, "daily");
  if (!text) throw new Error("Give a schedule, like “weekdays at 7:30am” or “every 2 hours”");
  if (/^[\d*,\-/a-z]+( [\d*,\-/a-z]+){4}$/.test(text) && /[\d*]/.test(text.split(" ")[0])) {
    parseCron(text);
    return { cron: text, label: `cron: ${text}` };
  }
  let m: RegExpExecArray | null;
  const at = (rest: string | undefined, fallback: [number, number] = [9, 0]) => (rest ? parseTime(rest) : fallback);
  if ((m = /^every (\d+) ?(?:minutes?|mins?|m)$/.exec(text))) {
    const n = Number(m[1]);
    if (n < 1 || n > 59) throw new Error("Minutes must be between 1 and 59; use hours for longer gaps");
    return { cron: `*/${n} * * * *`, label: n === 1 ? "Every minute" : `Every ${n} minutes` };
  }
  if ((m = /^(?:every hour|hourly)(?: at :?(\d{1,2}))?$/.exec(text))) {
    const min = Number(m[1] ?? 0);
    if (min > 59) throw new Error("Minutes past the hour must be 0–59");
    return { cron: `${min} * * * *`, label: min ? `Every hour at :${String(min).padStart(2, "0")}` : "Every hour" };
  }
  if ((m = /^every (\d+) ?(?:hours?|hrs?|h)$/.exec(text))) {
    const n = Number(m[1]);
    if (n < 1 || n > 23) throw new Error("Hours must be between 1 and 23; use daily for once a day");
    return { cron: `0 */${n} * * *`, label: n === 1 ? "Every hour" : `Every ${n} hours` };
  }
  if ((m = /^daily(?: at (.+))?$/.exec(text))) {
    const [h, min] = at(m[1]);
    return { cron: `${min} ${h} * * *`, label: `Every day at ${clock(h, min)}` };
  }
  if ((m = /^(?:on )?(weekdays|weekends)(?: at (.+))?$/.exec(text))) {
    const [h, min] = at(m[2]);
    return { cron: `${min} ${h} * * ${m[1] === "weekdays" ? "1-5" : "0,6"}`, label: `${m[1] === "weekdays" ? "Weekdays" : "Weekends"} at ${clock(h, min)}` };
  }
  if ((m = /^monthly(?: on(?: the)? (\d{1,2})(?:st|nd|rd|th)?)?(?: at (.+))?$/.exec(text))) {
    const day = Number(m[1] ?? 1);
    if (day < 1 || day > 28) throw new Error("Pick a day from 1 to 28, so every month has it");
    const [h, min] = at(m[2]);
    return { cron: `${min} ${h} ${day} * *`, label: `Monthly on the ${ordinal(day)} at ${clock(h, min)}` };
  }
  // "mondays at 9am", "every mon, wed and fri at 6pm", "weekly on friday at 17:00"
  if ((m = /^(?:every |weekly on |on )?([a-z ,]+?)(?: at (.+))?$/.exec(text))) {
    const words = m[1].split(/\s*(?:,|\band\b|&)\s*|\s+/).filter(Boolean);
    const days = words.map((w) => DAY_NAMES.indexOf(w.replace(/s$/, "").slice(0, 3)));
    if (words.length && days.every((d) => d >= 0) && words.every((w) => DAY_NAMES.some((n) => w.startsWith(n)))) {
      const [h, min] = at(m[2]);
      const uniq = [...new Set(days)].sort((a, b) => a - b);
      const names = uniq.map((d) => DAY_LABEL[d] + (uniq.length === 1 ? "s" : ""));
      return { cron: `${min} ${h} * * ${uniq.join(",")}`, label: `${names.join(", ")} at ${clock(h, min)}` };
    }
  }
  throw new Error("Try a schedule like “weekdays at 7:30am”, “every 2 hours”, “mondays at 9am”, “monthly on the 1st at 9:00” or five cron fields");
}

// --- Time zones -------------------------------------------------------------

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(t: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: DAY_NAMES.indexOf(String(p.weekday).toLowerCase().slice(0, 3)) };
}

/** The instant a wall-clock time happens in a time zone, or null when it doesn't exist (the hour skipped by daylight saving). */
function fromWallClock(y: number, mo: number, d: number, h: number, mi: number, tz: string): number | null {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  for (const probe of [guess, guess - 14 * 3600_000, guess + 14 * 3600_000]) {
    const w = wallClock(probe, tz);
    const offset = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(probe / 60000) * 60000;
    const t = guess - offset;
    const back = wallClock(t, tz);
    if (back.y === y && back.mo === mo && back.d === d && back.h === h && back.mi === mi) {
      // Ambiguous hour (clocks going back): take the first one
      const earlier = t - 3600_000;
      const e = wallClock(earlier, tz);
      return e.h === h && e.mi === mi && e.d === d ? earlier : t;
    }
  }
  return null;
}

/** The next time the schedule fires strictly after `after`, in time zone `tz`. */
export function nextRun(cron: Cron | string, after: number, tz: string): number | null {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  const start = wallClock(after, tz);
  // Walk local calendar days; most schedules find a match on day one or two
  for (let i = 0; i < 1500; i++) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
    const [y, mo, d, wd] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay()];
    if (!c.months.includes(mo)) continue;
    const domOk = c.days.includes(d);
    const dowOk = c.weekdays.includes(wd);
    // Cron rule: when both day fields are restricted, either may match
    const dayOk = c.anyDay && c.anyWeekday ? true : c.anyDay ? dowOk : c.anyWeekday ? domOk : domOk || dowOk;
    if (!dayOk) continue;
    for (const h of c.hours) {
      if (i === 0 && h < start.h) continue;
      for (const mi of c.minutes) {
        const t = fromWallClock(y, mo, d, h, mi, tz);
        if (t !== null && t > after) return t;
      }
    }
  }
  return null;
}

/** The next `count` run times. */
export function upcoming(cron: string, after: number, tz: string, count = 3): number[] {
  const c = parseCron(cron);
  const out: number[] = [];
  let t = after;
  while (out.length < count) {
    const n = nextRun(c, t, tz);
    if (n === null) break;
    out.push(n);
    t = n;
  }
  return out;
}

/** The shortest gap between runs over the next few dozen runs, in minutes. */
export function shortestGapMinutes(cron: string, tz: string, from = Date.now()): number {
  const runs = upcoming(cron, from, tz, 40);
  let gap = Infinity;
  for (let i = 1; i < runs.length; i++) gap = Math.min(gap, (runs[i] - runs[i - 1]) / 60000);
  return gap;
}
