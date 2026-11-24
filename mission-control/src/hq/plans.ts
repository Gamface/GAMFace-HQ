// Plan Markup. A "plan first" card's first run writes a plan and stops. You mark the
// plan up on the dashboard (comment on a part, cut it, or swap in other words), then
// either send it back for another version or approve it. Approving applies your cuts
// and replacements and sends the plan back to the same card, which then does the work.
//
// Pure functions only (no Node imports): the dashboard uses the same block splitting
// and edit logic to show your markup live.

export type AnnotationKind = "comment" | "delete" | "replace";

export interface PlanAnnotation {
  /** The block the marked text is in (from planBlocks) */
  blockId: string;
  /** The exact text marked; the whole block when it's the block's own text */
  quote: string;
  kind: AnnotationKind;
  /** The comment, or the replacement words */
  text?: string;
}

export interface PlanBlock {
  id: string;
  kind: "heading" | "list" | "code" | "paragraph";
  /** The block as written, Markdown markers included */
  raw: string;
  /** Where it starts in the plan */
  start: number;
  /** Heading level (1-6) for headings, nesting depth for list items */
  level?: number;
}

export interface PlanState {
  /** awaiting: waiting for your review; revising: your markup went back for a new version; approved: it ran (or is running) */
  status: "awaiting" | "revising" | "approved";
  version: number;
  text: string;
  /** When the current version was written */
  at: number;
  /** The markup from the last review, kept for the record */
  lastReview?: { decision: "approve" | "revise"; annotations: PlanAnnotation[]; note?: string; at: number };
}

export const PLAN_MAX_ANNOTATIONS = 60;

export const PLAN_RULES =
  "\n\nTHIS IS A PLAN-FIRST CARD. Don't do the work yet: no handoffs to teammates (write no @ lines), no file blocks, " +
  "no browsing that changes anything. Write a plan in Markdown that the user will mark up before anything runs:\n" +
  "- start with one line saying what the finished result will be\n" +
  "- then ## sections, each with numbered, concrete steps (which teammate or file each step touches)\n" +
  "- end with ## Risks and ## Open questions (each question with the options you see)\n" +
  "Keep each step on its own line so it can be commented on, cut or replaced on its own.";

const HEADING = /^(#{1,6})\s+/;
const LIST = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

/**
 * Splits a plan into blocks the user can mark up: headings, list items (one per item,
 * with their wrapped lines), code fences, and paragraphs. Blank lines separate blocks.
 */
export function planBlocks(md: string): PlanBlock[] {
  const blocks: PlanBlock[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let pos = 0;
  let cur: { kind: PlanBlock["kind"]; start: number; end: number; level?: number } | null = null;
  const close = () => {
    if (!cur) return;
    const raw = md.replace(/\r\n?/g, "\n").slice(cur.start, cur.end);
    if (raw.trim()) blocks.push({ id: `b${blocks.length + 1}`, kind: cur.kind, raw, start: cur.start, ...(cur.level !== undefined ? { level: cur.level } : {}) });
    cur = null;
  };
  let fence = false;
  for (const line of lines) {
    const start = pos;
    const end = pos + line.length;
    pos = end + 1;
    if (fence) {
      cur!.end = end;
      if (/^\s*(```|~~~)/.test(line)) {
        fence = false;
        close();
      }
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      close();
      cur = { kind: "code", start, end };
      fence = true;
      continue;
    }
    if (!line.trim()) {
      close();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      close();
      cur = { kind: "heading", start, end, level: h[1].length };
      close();
      continue;
    }
    const l = LIST.exec(line);
    if (l) {
      close();
      cur = { kind: "list", start, end, level: Math.floor(l[1].replace(/\t/g, "  ").length / 2) };
      continue;
    }
    // A wrapped line joins the block above (a paragraph or a list item)
    if (cur && cur.kind !== "heading") {
      cur.end = end;
      continue;
    }
    cur = { kind: "paragraph", start, end };
  }
  close();
  return blocks;
}

/** A block's text as shown: without its heading hashes or list marker. */
export function blockText(b: PlanBlock): string {
  if (b.kind === "heading") return b.raw.replace(HEADING, "");
  if (b.kind === "list") return b.raw.replace(LIST, "");
  return b.raw;
}

/** Where the marked text sits in the plan, or -1 when it isn't in its block any more. */
function locate(md: string, blocks: PlanBlock[], a: PlanAnnotation): number {
  const b = blocks.find((x) => x.id === a.blockId);
  if (!b || !a.quote) return -1;
  const i = b.raw.indexOf(a.quote);
  return i < 0 ? -1 : b.start + i;
}

/** Keeps markup that still points at text in the plan, with sane sizes. */
export function cleanAnnotations(md: string, input: PlanAnnotation[]): PlanAnnotation[] {
  const blocks = planBlocks(md);
  const out: PlanAnnotation[] = [];
  for (const a of input.slice(0, PLAN_MAX_ANNOTATIONS)) {
    const quote = String(a.quote ?? "").slice(0, 2000);
    const text = typeof a.text === "string" ? a.text.slice(0, 2000) : undefined;
    if (!["comment", "delete", "replace"].includes(a.kind)) continue;
    if (a.kind === "comment" && !text?.trim()) continue;
    const clean: PlanAnnotation = { blockId: String(a.blockId), quote, kind: a.kind, ...(text !== undefined && a.kind !== "delete" ? { text } : {}) };
    if (locate(md, blocks, clean) >= 0) out.push(clean);
  }
  return out;
}

/**
 * The plan with your cuts and replacements made. Comments don't change the text.
 * Overlapping edits: the one that starts first wins, the other is skipped.
 */
export function applyAnnotations(md: string, annotations: PlanAnnotation[]): string {
  const text = md.replace(/\r\n?/g, "\n");
  const blocks = planBlocks(text);
  const edits = annotations
    .filter((a) => a.kind !== "comment")
    .map((a) => ({ a, at: locate(text, blocks, a) }))
    .filter((e) => e.at >= 0)
    .sort((x, y) => x.at - y.at);
  let out = "";
  let pos = 0;
  for (const { a, at } of edits) {
    if (at < pos) continue; // overlaps an earlier edit
    out += text.slice(pos, at) + (a.kind === "replace" ? (a.text ?? "") : "");
    pos = at + a.quote.length;
  }
  out += text.slice(pos);
  // Drop list items and headings left empty by a cut, and runs of blank lines
  return out
    .split("\n")
    .filter((line) => !/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const short = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** Your markup as a list the agent can follow. */
export function describeAnnotations(annotations: PlanAnnotation[]): string {
  return annotations
    .map((a) =>
      a.kind === "comment"
        ? `- On “${short(a.quote)}”: ${a.text?.trim()}`
        : a.kind === "delete"
          ? `- Cut: “${short(a.quote)}”`
          : `- Replace “${short(a.quote)}” with “${short(a.text ?? "", 400)}”`,
    )
    .join("\n");
}

/** The reply that goes back to the card after a review. */
export function reviewMessage(plan: string, annotations: PlanAnnotation[], decision: "approve" | "revise", note?: string): string {
  const marks = describeAnnotations(annotations);
  const extra = note?.trim() ? `\n\nMy note: ${note.trim()}` : "";
  if (decision === "approve") {
    const comments = annotations.filter((a) => a.kind === "comment");
    return (
      "I approved the plan. Carry it out now, step by step. My cuts and replacements are already made below; " +
      "follow my comments where they apply.\n\nTHE APPROVED PLAN:\n" +
      applyAnnotations(plan, annotations) +
      (comments.length ? `\n\nMY COMMENTS:\n${describeAnnotations(comments)}` : "") +
      extra
    );
  }
  return (
    "Revise the plan. Don't start the work yet. Here is my markup on your last version:\n" +
    (marks || "(no inline markup)") +
    extra +
    "\n\nReply with the whole revised plan, in the same format."
  );
}
