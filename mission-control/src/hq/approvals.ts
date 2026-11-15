// Approvals (Phase 4). Before an agent changes anything in the world (types into a
// page, submits a form, clicks a button), it asks. The request shows up on the
// dashboard (and in Telegram when set up) with a screenshot; the agent waits until the
// user approves or denies, or until it times out, which counts as denied.
//
// Rules that no setting changes:
//   - passwords, payment details, bank numbers, ID numbers and one-time codes are never
//     typed, approved or not (the user enters those themselves)
//   - high-risk clicks (buy, pay, transfer, delete…) always ask, even when clicks are
//     set to "allow", and a "this card on this site" approval doesn't cover them
//   - unattended runs (routines) always ask: "allow" applies only to cards you started

import crypto from "node:crypto";
import { z } from "zod";

export const ActionKindSchema = z.enum(["type", "submit", "click", "search"]);
export type ActionKind = z.infer<typeof ActionKindSchema>;
const Mode = z.enum(["ask", "allow", "block"]);
export type ApprovalMode = z.infer<typeof Mode>;

export const ApprovalPolicySchema = z.object({
  type: Mode.default("ask"),
  submit: Mode.default("ask"),
  click: Mode.default("ask"),
  // Typing into a search box and searching (a GET form): low risk, allowed by default
  search: Mode.default("allow"),
  // How long a request waits for an answer before it counts as denied
  timeoutMinutes: z.number().int().min(1).max(240).default(15),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export const DEFAULT_POLICY: ApprovalPolicy = ApprovalPolicySchema.parse({});

export interface ActionRequest {
  kind: ActionKind;
  /** The button or field, as the page labels it */
  target: string;
  /** What would be typed */
  text?: string;
  url: string;
  site: string;
  /** JPEG screenshot (base64) with the target outlined */
  screenshot?: string;
}

export interface Approval {
  id: string;
  code: string; // short code for Telegram: /approve 3f9a1c
  taskId: string;
  taskTitle: string;
  agent: string;
  kind: ActionKind;
  target: string;
  text?: string;
  url: string;
  site: string;
  risk: "normal" | "high";
  unattended: boolean;
  status: "pending" | "approved" | "denied" | "expired" | "canceled";
  decidedBy?: "you" | "telegram" | "policy" | "timeout" | "card-grant";
  scope?: "once" | "card";
  note?: string;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  hasScreenshot: boolean;
}

const HIGH_RISK =
  /\b(buy|purchase|pay|payment|checkout|check out|place (your )?order|order now|subscribe|donate|transfer|send money|wire|withdraw|confirm (payment|order|purchase|transfer)|delete|remove account|close account|cancel (subscription|account)|unsubscribe|deactivate|book now|reserve now|sign (the )?contract|accept (the )?offer)\b/i;

/** Clicks that always need an answer from the user. */
export function isHighRisk(kind: ActionKind, target: string): boolean {
  return kind === "click" || kind === "submit" ? HIGH_RISK.test(target) : false;
}

const SENSITIVE_LABEL =
  /(pass(word|code|phrase)|\bpin\b|card ?(number|no)|credit card|debit card|\bcvv|\bcvc|security code|expir(y|ation)|\biban\b|routing|account number|sort code|\bssn\b|social security|national id|passport|tax id|one[- ]time|\botp\b|verification code|2fa|two[- ]factor|auth(entication)? code)/i;

/** Fields Mission Control never types into: passwords, payment, bank and ID numbers, one-time codes. */
export function isSensitiveField(f: { type?: string; autocomplete?: string; label?: string; name?: string }): boolean {
  if ((f.type ?? "").toLowerCase() === "password") return true;
  if (/^(cc-|current-password|new-password|one-time-code)/i.test(f.autocomplete ?? "")) return true;
  return SENSITIVE_LABEL.test(`${f.label ?? ""} ${f.name ?? ""}`);
}

export interface ApprovalHooks {
  /** A new request is waiting (send it to Telegram, log it). */
  onRequest?: (a: Approval) => void;
  /** A request was decided (log it, store it). */
  onDecision?: (a: Approval) => void;
}

interface Waiting {
  approval: Approval;
  screenshot?: string;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalCenter {
  private waiting = new Map<string, Waiting>();
  private recent: Approval[] = [];
  private grants = new Map<string, Set<string>>(); // taskId → "kind@site"
  policy: ApprovalPolicy = DEFAULT_POLICY;

  constructor(private hooks: ApprovalHooks = {}, private now: () => number = Date.now) {}

  /**
   * Asks for one action. Resolves to null when it may go ahead, or a reason when not.
   * Never throws; an aborted run cancels its request.
   */
  async check(
    req: ActionRequest,
    ctx: { taskId: string; taskTitle: string; agent: string; unattended: boolean; signal?: AbortSignal },
  ): Promise<string | null> {
    const risk = isHighRisk(req.kind, req.target) ? "high" : "normal";
    const mode = this.policy[req.kind];
    const base: Omit<Approval, "status"> = {
      id: crypto.randomUUID(),
      code: "",
      taskId: ctx.taskId,
      taskTitle: ctx.taskTitle.slice(0, 120),
      agent: ctx.agent,
      kind: req.kind,
      target: req.target.slice(0, 160),
      text: req.text?.slice(0, 500),
      url: req.url.slice(0, 500),
      site: req.site,
      risk,
      unattended: ctx.unattended,
      createdAt: this.now(),
      expiresAt: this.now() + this.policy.timeoutMinutes * 60_000,
      hasScreenshot: Boolean(req.screenshot),
    };
    base.code = base.id.replace(/-/g, "").slice(0, 6);
    if (mode === "block") return this.record({ ...base, status: "denied", decidedBy: "policy", note: `${req.kind} is set to “block”` }, "blocked by your approval settings");
    if (risk === "normal" && !ctx.unattended) {
      if (mode === "allow") return this.record({ ...base, status: "approved", decidedBy: "policy" }, null);
      if (this.grants.get(ctx.taskId)?.has(`${req.kind}@${req.site}`)) return this.record({ ...base, status: "approved", decidedBy: "card-grant" }, null);
    }
    if (ctx.signal?.aborted) return "the run was stopped";
    const approval: Approval = { ...base, status: "pending" };
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.finish(approval.id, false, "timeout"), Math.max(0, approval.expiresAt - this.now()));
      timer.unref?.();
      this.waiting.set(approval.id, { approval, screenshot: req.screenshot, resolve, timer });
      ctx.signal?.addEventListener("abort", () => this.finish(approval.id, false, "canceled"), { once: true });
      this.hooks.onRequest?.(approval);
    });
    if (ok) return null;
    return approval.status === "expired"
      ? `nobody answered within ${this.policy.timeoutMinutes} minutes`
      : approval.status === "canceled"
        ? "the run was stopped"
        : `the user declined${approval.note ? `: ${approval.note}` : ""}`;
  }

  private record(a: Approval, result: string | null): string | null {
    a.decidedAt = this.now();
    this.remember(a);
    this.hooks.onDecision?.(a);
    return result;
  }

  private remember(a: Approval) {
    this.recent.unshift(a);
    if (this.recent.length > 100) this.recent.length = 100;
  }

  private finish(id: string, ok: boolean, by: "you" | "telegram" | "timeout" | "canceled", scope: "once" | "card" = "once", note?: string) {
    const w = this.waiting.get(id);
    if (!w) return false;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    const a = w.approval;
    a.status = by === "timeout" ? "expired" : by === "canceled" ? "canceled" : ok ? "approved" : "denied";
    a.decidedBy = by === "canceled" ? undefined : by;
    a.decidedAt = this.now();
    a.note = note?.slice(0, 200) || undefined;
    if (ok && scope === "card" && a.risk === "normal") {
      a.scope = "card";
      const set = this.grants.get(a.taskId) ?? new Set<string>();
      set.add(`${a.kind}@${a.site}`);
      this.grants.set(a.taskId, set);
    } else if (ok) a.scope = "once";
    this.remember(a);
    this.hooks.onDecision?.(a);
    w.resolve(ok);
    return true;
  }

  /** The user's answer. Returns false when the request isn't waiting any more. */
  decide(idOrCode: string, approve: boolean, by: "you" | "telegram" = "you", scope: "once" | "card" = "once", note?: string): boolean {
    const id = this.waiting.has(idOrCode) ? idOrCode : [...this.waiting.keys()].find((k) => this.waiting.get(k)!.approval.code === idOrCode.toLowerCase());
    return id ? this.finish(id, approve, by, scope, note) : false;
  }

  pending(): Approval[] {
    return [...this.waiting.values()].map((w) => w.approval).sort((a, b) => a.createdAt - b.createdAt);
  }

  pendingFor(taskId: string): Approval | undefined {
    return this.pending().find((a) => a.taskId === taskId);
  }

  history(limit = 50): Approval[] {
    return this.recent.filter((a) => a.status !== "pending").slice(0, limit);
  }

  screenshot(id: string): string | undefined {
    return this.waiting.get(id)?.screenshot;
  }

  /** A card finished: its "this card on this site" approvals end with it. */
  endTask(taskId: string) {
    this.grants.delete(taskId);
    for (const [id, w] of this.waiting) if (w.approval.taskId === taskId) this.finish(id, false, "canceled");
  }
}
