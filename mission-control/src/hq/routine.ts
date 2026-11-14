import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { redact } from "./guard";

// Rules for routine runs (cards a schedule creates, source "routine"). Until
// the approval rules of Phase 4 exist, the server makes every routine run
// read-only, whatever the request says:
//   - the browser can only open pages, scroll, go back and follow links
//   - no notes are written to the vault and no memories are saved
//   - the result goes to the routine's own destination and nowhere else
// These are checked when the card is created, when it is edited, and again
// when it runs, so neither a client nor a stored card can switch them off.

export const DELIVERIES = ["dashboard", "telegram", "obsidian"] as const;
export type Delivery = (typeof DELIVERIES)[number];

export interface RoutineEnv {
  /** Chat that routine results are sent to (the first allowed Telegram chat), if Telegram is set up */
  telegramChat?: string;
  /** Obsidian vault folder, if one is set up */
  vault?: string;
}

export interface RoutineFields {
  readOnly: boolean;
  deliverTo?: Delivery;
  chatId?: string;
}

/** Works out a new card's read-only flag and destination. Returns an error message when the destination can't be used. */
export function routineFields(input: { source: string; readOnly?: boolean; deliverTo?: Delivery }, env: RoutineEnv): RoutineFields | { error: string } {
  if (input.source !== "routine") {
    if (input.deliverTo) return { error: "Only routine runs have a destination" };
    return { readOnly: Boolean(input.readOnly) };
  }
  const deliverTo = input.deliverTo ?? "dashboard";
  if (deliverTo === "telegram" && !env.telegramChat) return { error: "Telegram isn't set up (TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS), so a routine can't deliver there" };
  if (deliverTo === "obsidian" && !env.vault) return { error: "No Obsidian vault is set up (OBSIDIAN_VAULT), so a routine can't deliver there" };
  return { readOnly: true, deliverTo, chatId: deliverTo === "telegram" ? env.telegramChat : undefined };
}

export const isRoutine = (task: { source: string }) => task.source === "routine";

/** Refuses edits that would take a routine card out of read-only mode. */
export function routinePatchError(task: { source: string }, patch: { readOnly?: boolean }): string | null {
  if (isRoutine(task) && patch.readOnly === false) return "Routine runs are always read-only until approval rules exist";
  return null;
}

/**
 * What a routine run adds to the shared hive log. Its findings come from web
 * pages and stay on its own card, so other agents see that it ran, not what it found.
 */
export function hiveSummary(task: { source: string; title?: string; prompt: string }, event: string, summary: string): string {
  if (!isRoutine(task) || !["complete", "finished"].includes(event)) return summary;
  return `routine result kept on its card: ${task.title || task.prompt.split("\n")[0].slice(0, 80)}`;
}

/** The message sent to the routine's destination when a run ends. */
export function deliveryText(task: { status: string; title?: string; answer?: string; error?: string }): string {
  const name = task.title ? `${task.title}\n\n` : "";
  if (task.status === "complete") return name + (task.answer || "(no answer)");
  if (task.status === "error") return `${name}Routine run failed: ${task.error ?? "unknown error"}`;
  return `${name}Routine run canceled.`;
}

/** Saves a routine's result as one note in the vault's HQ/routines folder and returns its path. */
export function saveRoutineNote(vault: string, title: string, text: string, when = new Date()): string {
  const safe = title.replace(/[^\w \-]/g, "").trim().slice(0, 80) || "routine";
  const dir = path.join(vault, "HQ", "routines");
  mkdirSync(dir, { recursive: true });
  const stamp = when.toISOString().slice(0, 16).replace("T", " ").replace(":", "");
  const file = path.join(dir, `${stamp} ${safe}.md`);
  writeFileSync(file, redact(text).text.trim() + "\n");
  return file;
}
