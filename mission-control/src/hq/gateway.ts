import type { ModelRegistry, ModelRole, Resolved } from "./models";
import type { Notices } from "./notices";
import type { ChatMessage } from "./ollama";
import { resolvePrivate } from "./privacy";
import { chatOnce, chatStream } from "./providers";
import type { TaskStore } from "./taskstore";

// The one place model requests leave Mission Control. Every call (agent turns,
// delegation, synthesis, routing, memory, browser steps, and every fallback)
// goes through prepare(), which applies, in order:
//   1. the local-only lock: a local-only agent never reaches a cloud provider
//   2. the spend caps: per agent and overall, checked before the request with
//      an estimate of its input cost; over the cap means the local model
//   3. the private-context rule: vault notes, memories, the hive log and
//      anything produced from them are withheld from cloud models unless the
//      agent is allowed to send them
// Anything that falls back is noted in the card's output and on the dashboard.

export interface CallResult {
  text: string;
  json?: Record<string, unknown>;
  ref: string;
  /** True when private material was included (so the output is private too) */
  sawPrivate: boolean;
}

export interface Prepared {
  r: Resolved;
  messages: ChatMessage[];
  sawPrivate: boolean;
  notes: string[];
}

const LABEL: Record<string, string> = { planner: "Jarvis", coder: "Coder", browser: "Browser", file: "File", security_audit: "Security", router: "Router", memory: "Memory" };
const MARKERS = /[⟦⟧]/;

/** Dollars, with enough decimals to be useful for small caps. */
export function usd(x: number): string {
  return x > 0 && x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`;
}

export function estimateTokens(messages: ChatMessage[] | string): number {
  const chars = typeof messages === "string" ? messages.length : messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4);
}

export class ModelGateway {
  private models: ModelRegistry;
  private store: TaskStore;
  private notices: Notices;
  private keepAlive: string;
  /** Called after each successful request with the model that served it */
  onServed: (ref: string) => void = () => {};

  constructor(models: ModelRegistry, store: TaskStore, notices: Notices, keepAlive = "30m") {
    this.models = models;
    this.store = store;
    this.notices = notices;
    this.keepAlive = keepAlive;
  }

  /** Applies the lock, the caps and the privacy rule to one request. Exported for tests. */
  prepare(role: ModelRole, messages: ChatMessage[], candidate: Resolved): Prepared {
    const notes: string[] = [];
    const who = LABEL[role] ?? role;
    let r = candidate;

    // 1. Local-only lock
    if (!r.provider.local && r.settings.localOnly) {
      const local = this.models.localFor(role);
      const msg = `${who} is local only, so it used ${local.ref} instead of ${r.ref}.`;
      notes.push(msg);
      this.notices.add("local-only", `local-only:${role}:${r.ref}`, msg);
      r = local;
    }

    // 2. Spend caps (cloud only)
    if (!r.provider.local) {
      const settings = this.models.settings();
      const price = settings.prices[r.ref];
      const roleCap = r.settings.monthlyBudgetUsd;
      const allCap = settings.monthlyBudgetUsd;
      if ((roleCap !== undefined || allCap !== undefined) && !price) {
        const local = this.models.localFor(role);
        const msg = `No price is set for ${r.ref}, so its spend can't be capped. ${who} used ${local.ref} instead. Add the price on the Team page.`;
        notes.push(msg);
        this.notices.add("price-missing", `price:${r.ref}`, msg);
        r = local;
      } else if (price) {
        const estimate = (estimateTokens(messages) * price.input) / 1e6;
        const spentRole = this.store.spendThisMonth(role);
        const spentAll = this.store.spendThisMonth();
        let over: string | null = null;
        if (roleCap !== undefined && spentRole + estimate > roleCap) over = `${who}'s monthly budget of ${usd(roleCap)} is used up (${usd(spentRole)} spent${estimate > 0.00005 ? `, this request ≈ ${usd(estimate)}` : ""})`;
        else if (allCap !== undefined && spentAll + estimate > allCap) over = `The overall monthly budget of ${usd(allCap)} is used up (${usd(spentAll)} spent${estimate > 0.00005 ? `, this request ≈ ${usd(estimate)}` : ""})`;
        if (over) {
          const local = this.models.localFor(role);
          const msg = `${over}, so ${who} used ${local.ref} instead of ${r.ref}.`;
          notes.push(msg);
          this.notices.add("budget", `budget:${role}:${new Date().toISOString().slice(0, 7)}`, msg);
          r = local;
        }
      }
    }

    // 3. Private-context rule
    const allow = r.provider.local || Boolean(r.settings.allowPrivateToCloud);
    let sawPrivate = false;
    const out = messages.map((m) => {
      const res = resolvePrivate(m.content, allow);
      if (res.hadPrivate && allow) sawPrivate = true;
      return { ...m, content: res.text };
    });
    // Belt and braces: nothing marked may survive into a request
    if (out.some((m) => MARKERS.test(m.content))) throw new Error("Private-context markers survived preparation; request blocked");
    return { r, messages: out, sawPrivate, notes };
  }

  private cost(r: Resolved, promptTokens: number, completionTokens: number): number {
    if (r.provider.local) return 0;
    const price = this.models.settings().prices[r.ref];
    return price ? (promptTokens * price.input + completionTokens * price.output) / 1e6 : 0;
  }

  private record(role: ModelRole, r: Resolved, messages: ChatMessage[], text: string, reported: { promptTokens: number; completionTokens: number }) {
    // Some providers don't report usage; estimate so caps still count both directions
    const inTok = reported.promptTokens || (r.provider.local ? 0 : estimateTokens(messages));
    const outTok = reported.completionTokens || (r.provider.local ? 0 : estimateTokens(text));
    this.store.recordUsage(role, r.ref, inTok, outTok, false, this.cost(r, inTok, outTok));
    this.onServed(r.ref);
  }

  /** A streamed agent turn. `onNote` receives lines worth showing in the output (fallbacks, caps). */
  async stream(
    role: ModelRole,
    messages: ChatMessage[],
    signal: AbortSignal,
    onToken: (t: string) => void,
    onNote: (note: string) => void,
    override?: string,
  ): Promise<CallResult> {
    const attempt = async (candidate: Resolved): Promise<CallResult> => {
      const p = this.prepare(role, messages, candidate);
      p.notes.forEach(onNote);
      const s = p.r.settings;
      let gotTokens = false;
      try {
        const out = await chatStream(p.r.provider, p.r.model, p.messages, { numCtx: s.numCtx, temperature: s.temperature, think: s.think, keepAlive: this.keepAlive }, signal, (t) => {
          gotTokens = true;
          onToken(t);
        });
        this.record(role, p.r, p.messages, out.text, out);
        return { text: out.text, ref: p.r.ref, sawPrivate: p.sawPrivate };
      } catch (error) {
        // A cancel or timeout isn't the model's fault, so it doesn't count as a failed call
        if (!signal.aborted) this.store.recordUsage(role, p.r.ref, 0, 0, true);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { gotTokens });
      }
    };
    const primary = this.models.resolve(role, override);
    try {
      return await attempt(primary);
    } catch (error) {
      const fb = override ? null : this.models.resolveFallback(role);
      if (signal.aborted || (error as { gotTokens?: boolean }).gotTokens || !fb || fb.ref === primary.ref) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      onNote(`${primary.ref} failed (${msg.slice(0, 120)}); switching to ${fb.ref}.`);
      return attempt(fb); // the fallback goes through the same lock, caps and privacy rule
    }
  }

  /** A JSON-mode call for routing, memory and browser steps. Notes go to `onNote`. */
  async json(role: ModelRole, messages: ChatMessage[], onNote: (note: string) => void = () => {}): Promise<CallResult> {
    const attempt = async (candidate: Resolved): Promise<CallResult> => {
      const p = this.prepare(role, messages, candidate);
      p.notes.forEach(onNote);
      try {
        const out = await chatOnce(p.r.provider, p.r.model, p.messages, { json: true, think: false, temperature: 0.1, numCtx: p.r.settings.numCtx, keepAlive: this.keepAlive });
        this.record(role, p.r, p.messages, out.text, out);
        return { text: out.text, json: out.json ?? {}, ref: p.r.ref, sawPrivate: p.sawPrivate };
      } catch (error) {
        this.store.recordUsage(role, p.r.ref, 0, 0, true);
        throw error;
      }
    };
    const primary = this.models.resolve(role);
    try {
      return await attempt(primary);
    } catch (error) {
      const fb = this.models.resolveFallback(role);
      if (!fb || fb.ref === primary.ref) throw error;
      onNote(`${primary.ref} failed (${error instanceof Error ? error.message : error}); used ${fb.ref}.`);
      return attempt(fb);
    }
  }
}
