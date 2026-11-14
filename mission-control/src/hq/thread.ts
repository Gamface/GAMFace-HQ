// A card's conversation: replying to a finished card closes the round so far into
// its thread, and the next run gets those turns back as chat history.

import type { ThreadTurn } from "../schemas/agent";
import type { ChatMessage } from "./ollama";
import { privateBlock } from "./privacy";
import type { Task } from "./taskstore";

/** How many earlier turns go back to the model, and how long each may be */
export const HISTORY_TURNS = 12;
export const HISTORY_CHARS = 4000;
/** How many turns a card keeps */
export const THREAD_KEEP = 40;

/** Earlier turns as chat messages. Private turns and attachment notes are withheld from cloud models. */
export function historyMessages(thread: ThreadTurn[] | undefined): ChatMessage[] {
  const cut = (s: string) => (s.length > HISTORY_CHARS ? `${s.slice(0, HISTORY_CHARS)} …(cut)` : s);
  return (thread ?? []).slice(-HISTORY_TURNS).map((t) => {
    let content = cut(t.text);
    if (t.notes) content += `\n\n${privateBlock(cut(t.notes), "(Details of the attachments stay on the user's PC.)")}`;
    if (t.private) content = privateBlock(content, "(This earlier answer used private material and is withheld from cloud models.)");
    return { role: t.role === "user" ? "user" : "assistant", content };
  });
}

/** The card's thread with its current round (question and answer) added. */
export function closeRound(task: Task, now = Date.now()): ThreadTurn[] {
  const thread = [...(task.thread ?? [])];
  thread.push({
    role: "user",
    text: task.reply ?? task.prompt,
    images: task.images,
    audio: task.audio,
    notes: task.privateNotes,
    at: task.startedAt ?? task.createdAt,
  });
  thread.push({
    role: "agent",
    text: task.answer || (task.error ? `(The run failed: ${task.error})` : "(No answer: the run was stopped.)"),
    agent: task.targetAgent,
    private: task.usedPrivate,
    at: task.finishedAt ?? now,
  });
  // Drop whole rounds from the front so the thread always starts with the user
  return thread.slice(-THREAD_KEEP);
}
