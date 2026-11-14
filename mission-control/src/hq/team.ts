import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { JsonChat } from "./ollama";

// The agent team: who is on it, how tasks get routed, and how the lead hands
// work to teammates. Keys match AgentTargetSchema in ../schemas/agent.ts.

export type AgentKey = "planner" | "coder" | "browser" | "file" | "security_audit";

export interface TeamMember {
  key: AgentKey;
  name: string;
  role: string;
  prompt: string;
}

export const TEAM: Record<AgentKey, TeamMember> = {
  planner: {
    key: "planner",
    name: "Jarvis",
    role: "lead and planner",
    prompt:
      "You are Jarvis, a local AI engineering assistant running on WSL2. Break the request into clear, numbered steps and call out risks or missing information.",
  },
  coder: {
    key: "coder",
    name: "Jarvis Coder",
    role: "TypeScript and Python engineer",
    prompt:
      "You are Jarvis Coder, an expert TypeScript and Python engineer. Answer with working code and a short explanation. Prefer small, testable changes.",
  },
  browser: {
    key: "browser",
    name: "Jarvis Browser",
    role: "web research",
    prompt:
      "You are Jarvis Browser, a web research assistant. You cannot browse yet, so say what you would search for and which sources you would check, then answer from what you know.",
  },
  file: {
    key: "file",
    name: "Jarvis File",
    role: "vault, notes and local files",
    prompt:
      "You are Jarvis File, an assistant for the user's vault and local files. You cannot read files yet, so explain which files or notes you would need and how you would organize them.",
  },
  security_audit: {
    key: "security_audit",
    name: "Jarvis Defensive Security Auditor",
    role: "defensive security reviews",
    prompt:
      "You are Jarvis Defensive Security Auditor. Review the described system for exposed ports, weak configuration and missing hardening, and give prioritized, defensive fixes.",
  },
};

export const AGENT_KEYS = Object.keys(TEAM) as AgentKey[];

export function rosterText(exclude?: AgentKey): string {
  return AGENT_KEYS.filter((k) => k !== exclude)
    .map((k) => `- ${k}: ${TEAM[k].name}, ${TEAM[k].role}`)
    .join("\n");
}

// --- Routing ------------------------------------------------------------------
const KEYWORDS: [AgentKey, RegExp][] = [
  ["coder", /\b(code|script|function|bug|debug|python|typescript|javascript|regex|compile|refactor|npm|dockerfile)\b/i],
  ["security_audit", /\b(security|vulnerab\w*|audit|harden\w*|firewall|cve|exposed|open ports?)\b/i],
  ["file", /\b(notes?|obsidian|vault|files?|folder|organi[sz]e)\b/i],
  ["browser", /\b(search|look up|latest|news|website|web|price of)\b/i],
];

export function keywordRoute(prompt: string): AgentKey {
  for (const [key, pattern] of KEYWORDS) if (pattern.test(prompt)) return key;
  return "planner";
}

export async function routeTask(chat: JsonChat, model: string, prompt: string): Promise<{ agent: AgentKey; reason: string }> {
  try {
    const data = await chat(model, [
      {
        role: "system",
        content:
          "You route a user's request to one agent.\n" +
          rosterText() +
          "\nPick planner for chit-chat, vague requests, or anything that needs several specialists. " +
          'Reply with JSON only: {"agent": "<key>", "reason": "<a few words>"}',
      },
      { role: "user", content: prompt.slice(0, 2000) },
    ]);
    const key = String(data.agent ?? "").trim().toLowerCase() as AgentKey;
    if (AGENT_KEYS.includes(key)) return { agent: key, reason: String(data.reason ?? "").slice(0, 120) };
  } catch {
    // fall through to keywords
  }
  return { agent: keywordRoute(prompt), reason: "keyword match" };
}

// --- Delegation ---------------------------------------------------------------
export const DELEGATION_RULES =
  "\n\nYOU LEAD A TEAM. If the request needs specialist work, write one short sentence about your plan, " +
  "then one line per handoff in exactly this form and nothing after them:\n" +
  "@coder: <complete, self-contained instructions>\n" +
  "Teammates cannot see this conversation, so give each one everything it needs. Their results come back " +
  "to you to combine into the final answer. Delegate only when it clearly helps; if you can answer alone, " +
  "just answer and write no @ lines. Valid teammates: " +
  AGENT_KEYS.filter((k) => k !== "planner").join(", ") +
  ".";

export interface Delegation {
  agent: AgentKey;
  task: string;
}

export function parseDelegations(text: string, max = 4): Delegation[] {
  const out: Delegation[] = [];
  const re = /^[ \t]*(?:[-*]\s*)?@(\w+)\s*:\s*(.+)$/gm;
  for (const m of text.matchAll(re)) {
    const agent = m[1].toLowerCase() as AgentKey;
    if (agent !== "planner" && AGENT_KEYS.includes(agent) && m[2].trim().length > 3) {
      out.push({ agent, task: m[2].trim() });
    }
    if (out.length >= max) break;
  }
  return out;
}

export function synthesisPrompt(original: string, results: { agent: AgentKey; task: string; output: string }[]): string {
  const parts = results
    .map((r) => `### ${r.agent}: ${r.task}\n${r.output.trim() || "(no answer)"}`)
    .join("\n\n");
  return (
    `Original request: ${original}\n\nYour teammates finished their parts:\n\n${parts}\n\n` +
    "Combine this into one clear final answer for the user. Keep the useful code and specifics; drop repetition."
  );
}

// --- Obsidian vault -----------------------------------------------------------
export function vaultNotes(vault: string, agent: AgentKey, limit = 3000): string {
  if (!vault) return "";
  const base = path.join(vault, "HQ");
  const parts: string[] = [];
  for (const file of [path.join(base, "shared.md"), path.join(base, "agents", `${agent}.md`)]) {
    if (existsSync(file)) parts.push(`## ${path.basename(file)}\n${readFileSync(file, "utf8")}`);
  }
  return parts.join("\n\n").slice(0, limit);
}

export const NOTE_RULES =
  '\n\nIf something is worth keeping in the user\'s Obsidian vault, end your answer with <note title="Short title">markdown content</note>. ' +
  "It is saved to the vault's HQ/inbox folder.";

export function saveNotes(vault: string, text: string): string[] {
  if (!vault) return [];
  const saved: string[] = [];
  for (const m of text.matchAll(/<note title="([^"]{1,120})">([\s\S]*?)<\/note>/g)) {
    const safe = m[1].replace(/[^\w \-]/g, "").trim().slice(0, 80) || "note";
    const dir = path.join(vault, "HQ", "inbox");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)} ${safe}.md`);
    writeFileSync(file, m[2].trim() + "\n");
    saved.push(file);
  }
  return saved;
}

// --- Prompt context -------------------------------------------------------------
// Ollama reuses its work for the part of a prompt that is identical to the last
// call (prefix caching). So the system prompt holds only text that rarely
// changes (persona, team, rules, vault notes) and everything that changes on
// every call (hive log, recalled memories) travels with the user message.

/** Stable part, for the end of the system prompt. */
export function teamContext(agent: AgentKey, notes = ""): string {
  return `\n\nYOUR TEAM:\n${rosterText(agent)}` + (notes ? `\n\nNOTES FROM THE VAULT:\n${notes}` : "");
}

/** Changing part, wrapped around the user's request. */
export function withLiveContext(request: string, opts: { hive: string; memories: string[] }): string {
  return (
    `[Context for reference: do not answer it]\n` +
    `HIVE MIND (recent team activity):\n${opts.hive}\n\n` +
    `RELEVANT MEMORIES:\n${opts.memories.map((m) => `- ${m}`).join("\n") || "(none)"}\n` +
    `[End of context]\n\nREQUEST:\n${request}`
  );
}
