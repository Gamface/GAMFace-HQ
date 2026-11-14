import { redact } from "./guard";
import { JsonStore } from "./store";

// The hive mind: one shared activity log that every agent sees in its prompt,
// so each one knows what the rest of the team has been doing.
export interface HiveEntry {
  ts: number;
  agent: string;
  event: string;
  summary: string;
  taskId?: string;
}

const MAX_ENTRIES = 500;

export class Hive {
  private store: JsonStore<HiveEntry[]>;

  constructor(dataDir: string) {
    this.store = new JsonStore<HiveEntry[]>(dataDir, "hive.json", []);
  }

  log(agent: string, event: string, summary: string, taskId?: string) {
    const entry: HiveEntry = { ts: Date.now(), agent, event, summary: redact(summary).text.replace(/\s+/g, " ").slice(0, 300), taskId };
    this.store.data.push(entry);
    if (this.store.data.length > MAX_ENTRIES) this.store.data.splice(0, this.store.data.length - MAX_ENTRIES);
    this.store.save();
    return entry;
  }

  recent(limit = 25): HiveEntry[] {
    return this.store.data.slice(-limit);
  }

  /** Who did what, without the details: safe to show a cloud model. */
  publicText(limit = 15): string {
    const rows = this.recent(limit).filter((h) => !["guard", "memory", "models", "telegram"].includes(h.agent));
    if (!rows.length) return "(nothing yet)";
    return rows.map((h) => `[${new Date(h.ts).toTimeString().slice(0, 5)}] ${h.agent} ${h.event}`).join("\n");
  }

  /** Compact text for system prompts. */
  promptText(limit = 15): string {
    const rows = this.recent(limit);
    if (!rows.length) return "(nothing yet)";
    return rows
      .map((h) => `[${new Date(h.ts).toTimeString().slice(0, 5)}] ${h.agent} ${h.event}: ${h.summary}`)
      .join("\n");
  }
}
