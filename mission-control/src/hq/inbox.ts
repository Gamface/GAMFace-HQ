// Decision Inbox. An agent that needs a decision doesn't stop and wait: it makes its
// best assumption, finishes what it can, and ends its answer with a question for you.
// The question waits in the Inbox (Questions / To review / Finished work). When you
// answer, it goes back to that card as a reply and the card runs again from there.
//
// Questions are written to SQLite beside the cards, so they survive a restart.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const ASK_RULES =
  "\n\nIF YOU NEED A DECISION FROM THE USER, don't stop and wait for it. Make the most sensible assumption, " +
  "say which one you made, finish what you can, and end your answer with the question in exactly this form:\n" +
  '<ask options="First choice|Second choice|Third choice">Your question?</ask>\n' +
  "At most 2 questions, 2 to 5 short options each (leave options out for an open question). The user answers " +
  "later from their Inbox and you get the answer as a reply. Ask only when the choice really is theirs.";

export const MAX_ASKS = 2;
const MAX_OPTIONS = 5;

export interface Ask {
  question: string;
  options: string[];
}

const ASK_RE = /<ask(?:\s+options\s*=\s*"([^"]*)")?\s*>([\s\S]*?)<\/ask>/gi;

/** The questions at the end of an answer, and the answer without them. */
export function parseAsks(text: string): { asks: Ask[]; text: string } {
  const asks: Ask[] = [];
  for (const m of text.matchAll(ASK_RE)) {
    const question = m[2].replace(/\s+/g, " ").trim().slice(0, 500);
    if (!question) continue;
    const options = [...new Set((m[1] ?? "").split("|").map((o) => o.replace(/\s+/g, " ").trim().slice(0, 120)).filter(Boolean))].slice(0, MAX_OPTIONS);
    if (asks.length < MAX_ASKS) asks.push({ question, options: options.length >= 2 ? options : [] });
  }
  return { asks, text: text.replace(ASK_RE, "").replace(/\n{3,}/g, "\n\n").trim() };
}

export interface Question {
  id: string;
  /** Short code for Telegram */
  code: string;
  taskId: string;
  taskTitle: string;
  agent: string;
  question: string;
  options: string[];
  status: "open" | "answered" | "dismissed";
  answer?: string;
  note?: string;
  /** True once the answer went back to the card */
  delivered?: boolean;
  createdAt: number;
  answeredAt?: number;
}

export class QuestionStore {
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS questions_task ON questions(task_id, at);
      CREATE INDEX IF NOT EXISTS questions_status ON questions(status, at);
    `);
  }

  private save(q: Question) {
    this.db
      .prepare("INSERT INTO questions (id, task_id, status, at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data")
      .run(q.id, q.taskId, q.status, q.createdAt, JSON.stringify(q));
  }

  private rows(sql: string, ...args: (string | number)[]): Question[] {
    return (this.db.prepare(sql).all(...args) as { data: string }[]).map((r) => JSON.parse(r.data) as Question);
  }

  /** Posts a card's new questions. Its older open ones are replaced: the new answer supersedes them. */
  post(task: { id: string; title: string; agent: string }, asks: Ask[]): Question[] {
    for (const old of this.open(task.id)) this.save({ ...old, status: "dismissed", answeredAt: this.now(), note: "replaced by a newer question" });
    return asks.slice(0, MAX_ASKS).map((a) => {
      const id = crypto.randomUUID();
      const q: Question = {
        id,
        code: id.replace(/-/g, "").slice(0, 6),
        taskId: task.id,
        taskTitle: task.title.slice(0, 120),
        agent: task.agent,
        question: a.question,
        options: a.options,
        status: "open",
        createdAt: this.now(),
      };
      this.save(q);
      return q;
    });
  }

  get(idOrCode: string): Question | undefined {
    const byId = this.rows("SELECT data FROM questions WHERE id = ?", idOrCode)[0];
    if (byId) return byId;
    return this.rows("SELECT data FROM questions WHERE status = 'open' ORDER BY at").find((q) => q.code === idOrCode.toLowerCase());
  }

  /** Open questions, oldest first; for one card when given. */
  open(taskId?: string): Question[] {
    return taskId
      ? this.rows("SELECT data FROM questions WHERE status = 'open' AND task_id = ? ORDER BY at", taskId)
      : this.rows("SELECT data FROM questions WHERE status = 'open' ORDER BY at");
  }

  /** Records your answer. Returns null when the question isn't open any more. */
  answer(idOrCode: string, answer: string, note?: string): Question | null {
    const q = this.get(idOrCode);
    if (!q || q.status !== "open") return null;
    const done: Question = { ...q, status: "answered", answer: answer.trim().slice(0, 1000), note: note?.trim().slice(0, 1000) || undefined, answeredAt: this.now() };
    this.save(done);
    return done;
  }

  dismiss(idOrCode: string): boolean {
    const q = this.get(idOrCode);
    if (!q || q.status !== "open") return false;
    this.save({ ...q, status: "dismissed", answeredAt: this.now() });
    return true;
  }

  /** A card left the board: its open questions go with it. */
  dropTask(taskId: string) {
    for (const q of this.open(taskId)) this.save({ ...q, status: "dismissed", answeredAt: this.now(), note: "the card was removed" });
  }

  /** Answers for this card that haven't gone back to it yet. */
  undelivered(taskId: string): Question[] {
    return this.rows("SELECT data FROM questions WHERE status = 'answered' AND task_id = ? ORDER BY at", taskId).filter((q) => !q.delivered);
  }

  markDelivered(ids: string[]) {
    for (const id of ids) {
      const q = this.get(id);
      if (q) this.save({ ...q, delivered: true });
    }
  }

  /** Answered and dismissed questions, newest first. */
  recent(limit = 20): Question[] {
    return this.rows("SELECT data FROM questions WHERE status != 'open' ORDER BY at DESC LIMIT ?", limit);
  }
}

/** The reply a card gets with your answers. */
export function answerMessage(answered: Question[]): string {
  const parts = answered.map((q) => `You asked: ${q.question}\nMy answer: ${q.answer}${q.note ? `\nNote: ${q.note}` : ""}`);
  return `${parts.join("\n\n")}\n\nCarry on with ${answered.length > 1 ? "these answers" : "this answer"}.`;
}

/**
 * When answers may go back to a card: it has to be finished (not queued or running),
 * and every question it asked has to be answered or dismissed, so it gets them in one go.
 */
export function readyToDeliver(store: QuestionStore, taskId: string, finished: boolean): Question[] {
  if (!finished || store.open(taskId).length) return [];
  return store.undelivered(taskId);
}
