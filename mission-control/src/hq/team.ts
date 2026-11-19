import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { JsonChat } from "./ollama";
import { privateBlock, sanitize } from "./privacy";

// The agent team: who is on it, how tasks get routed, and how the lead hands
// work to teammates. Keys match AgentTargetSchema in ../schemas/agent.ts.

export type AgentKey = "planner" | "coder" | "browser" | "file" | "security_audit" | "vision" | "tools";

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
      "You are Jarvis, a local AI engineering assistant running on WSL2. Break the request into clear, numbered steps and call out risks or missing information. " +
      "If neither you nor a teammate or installed tool can do what's asked (for example make a picture when no picture tool is installed), say so plainly in one sentence and say what would make it possible. Never invent a reason.",
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
    role: "the user's own vault notes and attached PDFs: reading, finding and summarizing them (not for writing new documents or reports)",
    prompt:
      "You are Jarvis File, an assistant for the user's vault notes and attached documents. Work from the notes and document contents you are given, and cite page numbers when quoting a PDF. If what you need isn't there, say which files or notes would help.",
  },
  security_audit: {
    key: "security_audit",
    name: "Jarvis Defensive Security Auditor",
    role: "defensive security reviews",
    prompt:
      "You are Jarvis Defensive Security Auditor. Review the described system for exposed ports, weak configuration and missing hardening, and give prioritized, defensive fixes.",
  },
  vision: {
    key: "vision",
    name: "Jarvis Vision",
    role: "reads pictures the user attached: screenshots, photos, diagrams, documents (it can't make pictures)",
    prompt:
      "You are Jarvis Vision. Look carefully at the attached pictures and answer about what they actually show: read text exactly, describe layouts, errors, diagrams and details. Say plainly when something is unclear or not visible. " +
      "If no picture is attached, say only that no picture came with the request and that you read pictures but can't make them. Never guess at other attachments.",
  },
  tools: {
    key: "tools",
    name: "Jarvis Tools",
    role: "answers with the installed tools (MCP servers)",
    prompt:
      "You are Jarvis Tools. You answer by calling the installed tools and reporting what they returned. You can't call tools in this turn, so say which tool would answer it and what you would ask it.",
  },
};

export const AGENT_KEYS = Object.keys(TEAM) as AgentKey[];

// What the installed tools can do (read-only ones), or null when there are none. The Tools
// teammate is offered to the router and the lead only while this is set.
let toolsSummary: string | null = null;

/** Sets what the installed tools do ("demo: echo (Repeats…), time (…)"); null hides the Tools teammate. */
export function setToolsSummary(summary: string | null) {
  toolsSummary = summary?.trim() ? summary.trim().slice(0, 1500) : null;
}

export const toolsAvailable = () => toolsSummary !== null;

/** The teammates that can take work now (Tools only while tools are installed). */
export function activeAgents(): AgentKey[] {
  return AGENT_KEYS.filter((k) => k !== "tools" || toolsSummary !== null);
}

export function rosterText(exclude?: AgentKey): string {
  return activeAgents()
    .filter((k) => k !== exclude)
    .map((k) => `- ${k}: ${TEAM[k].name}, ${TEAM[k].role}${k === "tools" ? `. Installed: ${toolsSummary}` : ""}`)
    .join("\n");
}

// --- Routing ------------------------------------------------------------------
const KEYWORDS: [AgentKey, RegExp][] = [
  ["coder", /\b(code|script|function|bug|debug|python|typescript|javascript|regex|compile|refactor|npm|dockerfile)\b/i],
  ["security_audit", /\b(security|vulnerab\w*|audit|harden\w*|firewall|cve|exposed|open ports?)\b/i],
  ["vision", /\b(screenshot|picture|photo|image|diagram|this pic)\b/i],
  ["file", /\b(notes?|obsidian|vault|files?|folder|organi[sz]e)\b/i],
  ["browser", /\b(search|look up|latest|news|website|web|price of)\b/i],
];

const WEB_SIGNS =
  /\b(search|google|look(ing)? up|find|research|browse|online|internet|web|website|site|url|link|page|news|latest|current(ly)?|recent|today|tonight|yesterday|tomorrow|this (week|month|year)|right now|weather|forecast|price|prices|cost|buy|deals?|stock|score|who won|release[ds]?|reviews?|compare|sources?|open|go to|visit|youtube|reddit|amazon|wikipedia|20\d\d)\b|https?:\/\/|www\.|\.(com|org|net|io|dev|ai)\b/i;

/** Whether a request shows any sign of needing the web. Exported for tests. */
export function needsWeb(prompt: string): boolean {
  return WEB_SIGNS.test(prompt);
}

const MAKE_PICTURE =
  // the verb, then (without passing code, an app or a page: "create a script that resizes images") the picture
  /\b(make|create|draw|generate|paint|render|design|produce|imagine|sketch|illustrate)\b(?:(?!\b(?:scripts?|code|functions?|programs?|apps?|tools?|pages?|sites?|websites?|components?|class|folders?|galler(?:y|ies)|bots?|commands?)\b)[^.?!\n]){0,60}?\b(pictures?|photos?|photographs?|images?|drawings?|illustrations?|paintings?|portraits?|artwork|wallpapers?|logos?|posters?|icons?|sketch(es)?)\b/i;

/** Whether the request asks for a new picture to be made (not one read). Exported for tests. */
export function wantsPicture(prompt: string): boolean {
  return MAKE_PICTURE.test(prompt);
}

/** Whether an installed tool makes pictures. */
const canMakePictures = () => /\bgenerate_image\b/.test(toolsSummary ?? "");

export function keywordRoute(prompt: string): AgentKey {
  // "Make a photo of…" is for the picture tool (or Jarvis, to say there isn't one), never Vision
  if (wantsPicture(prompt)) return canMakePictures() ? "tools" : "planner";
  for (const [key, pattern] of KEYWORDS) if (pattern.test(prompt)) return key;
  return "planner";
}

export async function routeTask(chat: JsonChat, model: string, prompt: string): Promise<{ agent: AgentKey; reason: string }> {
  // Small routing models send "make a photo of…" to Vision, which only reads pictures
  if (wantsPicture(prompt)) return canMakePictures() ? { agent: "tools", reason: "make a picture" } : { agent: "planner", reason: "no picture tool installed" };
  try {
    const data = await chat(model, [
      {
        role: "system",
        content:
          "You route a user's request to one agent.\n" +
          rosterText() +
          "\nPick planner for chit-chat, vague requests, or anything that needs several specialists. " +
          "Writing a document, report or PDF goes to planner, or to browser when it needs current facts or real pictures from the web; " +
          "file is only for reading or organizing the user's own notes. " +
          (toolsSummary ? "Pick tools when one of its installed tools clearly answers the request. " : "") +
          'Reply with JSON only: {"agent": "<key>", "reason": "<a few words>"}',
      },
      { role: "user", content: prompt.slice(0, 2000) },
    ]);
    const key = String(data.agent ?? "").trim().toLowerCase() as AgentKey;
    // Small routing models send greetings and one-word replies to the browser; it then
    // has nothing to look up. Without any sign of needing the web, Jarvis answers.
    if (key === "browser" && !needsWeb(prompt)) return { agent: "planner", reason: "doesn't need the web" };
    if (key === "tools" && !toolsSummary) return { agent: "planner", reason: "no tools installed" };
    if (AGENT_KEYS.includes(key)) return { agent: key, reason: String(data.reason ?? "").slice(0, 120) };
  } catch {
    // fall through to keywords
  }
  return { agent: keywordRoute(prompt), reason: "keyword match" };
}

// --- Delegation ---------------------------------------------------------------
/** The lead's handoff rules, naming the teammates that can take work now. */
export function delegationRules(): string {
  return (
    "\n\nYOU LEAD A TEAM. If the request needs specialist work, write one short sentence about your plan, " +
    "then one line per handoff in exactly this form and nothing after them:\n" +
    "@coder: <complete, self-contained instructions>\n" +
    "Teammates cannot see this conversation, so give each one everything it needs. Their results come back " +
    "to you to combine into the final answer. Delegate only when it clearly helps; if you can answer alone, " +
    "just answer and write no @ lines. Valid teammates: " +
    activeAgents()
      .filter((k) => k !== "planner")
      .join(", ") +
    "." +
    (toolsSummary ? ` The tools teammate can use: ${toolsSummary}.` : "")
  );
}

export interface Delegation {
  agent: AgentKey;
  task: string;
}

export function parseDelegations(text: string, max = 4): Delegation[] {
  const out: Delegation[] = [];
  const re = /^[ \t]*(?:[-*]\s*)?@(\w+)\s*:\s*(.+)$/gm;
  for (const m of text.matchAll(re)) {
    const agent = m[1].toLowerCase() as AgentKey;
    if (agent !== "planner" && activeAgents().includes(agent) && m[2].trim().length > 3) {
      out.push({ agent, task: m[2].trim() });
    }
    if (out.length >= max) break;
  }
  return out;
}

export const WITHHELD_TEAMMATE = "(withheld from cloud models: this teammate worked from your private notes or memories)";

export function synthesisPrompt(original: string, results: { agent: AgentKey; task: string; output: string; private?: boolean }[]): string {
  const parts = results
    .map((r) => {
      const body = sanitize(r.output.trim()) || "(no answer)";
      // Answers written after seeing private material are private too
      return `### ${r.agent}: ${r.task}\n${r.private ? privateBlock(body, WITHHELD_TEAMMATE) : body}`;
    })
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
    // Never overwrite a note that's already there: add (2), (3)…
    const base = `${new Date().toISOString().slice(0, 10)} ${safe}`;
    let file = path.join(dir, `${base}.md`);
    for (let n = 2; existsSync(file) && n < 1000; n++) file = path.join(dir, `${base} (${n}).md`);
    writeFileSync(file, m[2].trim() + "\n", { flag: "wx" });
    saved.push(file);
  }
  return saved;
}

// --- Prompt context -------------------------------------------------------------
// Ollama reuses its work for the part of a prompt that is identical to the last
// call (prefix caching). So the system prompt holds only text that rarely
// changes (persona, team, rules, vault notes) and everything that changes on
// every call (hive log, recalled memories) travels with the user message.

/** Stable part, for the end of the system prompt. Vault notes are private: cloud models don't get them. */
export function teamContext(agent: AgentKey, notes = ""): string {
  return `\n\nYOUR TEAM:\n${rosterText(agent)}` + (notes ? privateBlock(`\n\nNOTES FROM THE VAULT:\n${notes}`) : "");
}

/**
 * Changing part, wrapped around the user's request. The hive log and memories
 * are private: cloud models get the hive as bare activity (no details) and no memories.
 */
export function withLiveContext(request: string, opts: { hive: string; hivePublic?: string; memories: string[] }): string {
  const memories = opts.memories.map((m) => `- ${m}`).join("\n") || "(none)";
  return (
    `[Context for reference: do not answer it]\n` +
    privateBlock(
      `HIVE MIND (recent team activity):\n${opts.hive}\n\n`,
      `HIVE MIND (activity only; details withheld from cloud models):\n${opts.hivePublic ?? "(withheld)"}\n\n`,
    ) +
    privateBlock(`RELEVANT MEMORIES:\n${memories}\n`, opts.memories.length ? "RELEVANT MEMORIES: (withheld from cloud models)\n" : "") +
    `[End of context]\n\nREQUEST:\n${sanitize(request)}`
  );
}
