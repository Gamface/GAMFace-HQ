// Who is at the controls of a browser: the agent, or you (Phase 5).
// You can take over a running agent's browser, for example to sign in or pass a
// check; the agent waits, without acting, until you hand it back. The agent can
// also ask you to take over ("hand off") when a page needs you.

export type Controller = "agent" | "user";

export class BrowserControl {
  state: Controller = "agent";
  /** Why the user has control (the agent's request, when it asked) */
  reason?: string;
  requestedBy?: "user" | "agent";
  since?: number;
  private waiters: (() => void)[] = [];

  constructor(private onChange: (c: BrowserControl) => void = () => {}) {}

  takeOver(by: "user" | "agent", reason?: string) {
    if (this.state === "user") return;
    this.state = "user";
    this.requestedBy = by;
    this.reason = reason?.slice(0, 300);
    this.since = Date.now();
    this.onChange(this);
  }

  handBack() {
    if (this.state === "agent") return;
    this.state = "agent";
    this.reason = undefined;
    this.requestedBy = undefined;
    this.since = undefined;
    this.waiters.splice(0).forEach((r) => r());
    this.onChange(this);
  }

  /** Waits while the user has control. Hands back by itself after `timeoutMs`. */
  async waitForAgent(signal: AbortSignal | undefined, timeoutMs: number): Promise<"returned" | "timeout" | "aborted"> {
    if (this.state === "agent") return "returned";
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Report the timeout, not a hand-back, then give the browser back
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve("timeout");
        this.handBack();
      }, timeoutMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve(signal?.aborted ? "aborted" : "returned");
      };
      this.waiters.push(done);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((w) => w !== done);
          resolve("aborted");
        },
        { once: true },
      );
    });
  }
}
