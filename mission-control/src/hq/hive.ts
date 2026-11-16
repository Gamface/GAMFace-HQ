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
  // The card's project: null for General, missing for team-wide events (model changes…)
  project?: string | null;
}

const MAX_ENTRIES = 500;

export class Hive {
  private store: JsonStore<HiveEntry[]>;

  /** Finds a card's project, so entries about it are only shown in that project. */
  projectOf: (taskId: string) => string | null | undefined = () => undefined;

  constructor(dataDir: string) {
    this.store = new JsonStore<HiveEntry[]>(dataDir, "hive.json", []);
  }

  log(agent: string, event: string, summary: string, taskId?: string) {
    const entry: HiveEntry = { ts: Date.now(), agent, event, summary: redact(summary).text.replace(/\s+/g, " ").slice(0, 300), taskId };
    if (taskId) {
      const project = this.projectOf(taskId);
      if (project !== undefined) entry.project = project;
    }
    this.store.data.push(entry);
    if (this.store.data.length > MAX_ENTRIES) this.store.data.splice(0, this.store.data.length - MAX_ENTRIES);
    this.store.save();
    return entry;
  }

  /** The latest entries; with a project, only its own and team-wide ones (undefined: all). */
  recent(limit = 25, project?: string | null): HiveEntry[] {
    if (project === undefined) return this.store.data.slice(-limit);
    const out: HiveEntry[] = [];
    for (let i = this.store.data.length - 1; i >= 0 && out.length < limit; i--) {
      const h = this.store.data[i];
      if (h.project === undefined || h.project === project) out.push(h);
    }
    return out.reverse();
  }

  /** Who did what, without the details: safe to show a cloud model. */
  publicText(limit = 15, project?: string | null): string {
    const rows = this.recent(limit, project).filter((h) => !["guard", "memory", "models", "telegram"].includes(h.agent));
    if (!rows.length) return "(nothing yet)";
    return rows.map((h) => `[${new Date(h.ts).toTimeString().slice(0, 5)}] ${h.agent} ${h.event}`).join("\n");
  }

  /** Compact text for system prompts. */
  promptText(limit = 15, project?: string | null): string {
    const rows = this.recent(limit, project);
    if (!rows.length) return "(nothing yet)";
    return rows
      .map((h) => `[${new Date(h.ts).toTimeString().slice(0, 5)}] ${h.agent} ${h.event}: ${h.summary}`)
      .join("\n");
  }
}
