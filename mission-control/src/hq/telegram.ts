import { redact } from "./guard";
import { AGENT_KEYS } from "./team";

// Telegram front end. Long-polls the Bot API; only chat IDs on the allowlist
// can run tasks. Anyone else is told their chat ID once, and nothing runs.

export interface TelegramDeps {
  submit: (prompt: string, agent: string, chatId: string) => { taskId?: string; error?: string };
  queueText: () => string;
  log: (event: string, summary: string) => void;
}

export class TelegramBot {
  private offset = 0;
  private warned = new Set<string>();
  private token: string;
  private allowed: Set<string>;
  private deps: TelegramDeps;
  private stopped = false;

  constructor(token: string, allowed: Set<string>, deps: TelegramDeps) {
    this.token = token;
    this.allowed = allowed;
    this.deps = deps;
  }

  private async call(method: string, params: Record<string, unknown>, timeoutMs = 40000) {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await res.json()) as { ok: boolean; result?: unknown };
  }

  async send(chatId: string, text: string) {
    const clean = redact(text || "(empty)").text;
    for (let i = 0; i < clean.length; i += 4000) {
      await this.call("sendMessage", { chat_id: chatId, text: clean.slice(i, i + 4000) }, 20000);
    }
  }

  async handle(message: { chat?: { id?: number | string }; text?: string }) {
    const chatId = String(message.chat?.id ?? "");
    let text = (message.text ?? "").trim();
    if (!chatId || !text) return;
    if (!this.allowed.has(chatId)) {
      if (!this.warned.has(chatId)) {
        this.warned.add(chatId);
        await this.send(chatId, `Not authorised. Your chat ID is ${chatId}; add it to TELEGRAM_ALLOWED_CHAT_IDS to use this bot.`);
        this.deps.log("rejected", `unknown chat ${chatId}`);
      }
      return;
    }
    let agent = "auto";
    if (text.startsWith("/")) {
      const [cmdRaw, ...rest] = text.slice(1).split(/\s+/);
      const cmd = cmdRaw.split("@")[0].toLowerCase();
      if (cmd === "start" || cmd === "help") {
        return this.send(chatId, `Send any task and it is routed automatically. Pick an agent with /<agent> <task>: ${AGENT_KEYS.map((k) => "/" + k).join(" ")}. /status shows the queue.`);
      }
      if (cmd === "status") return this.send(chatId, this.deps.queueText());
      if ((AGENT_KEYS as string[]).includes(cmd) && rest.length) {
        agent = cmd;
        text = rest.join(" ");
      }
    }
    const result = this.deps.submit(text, agent, chatId);
    await this.send(chatId, result.error ? `Not queued: ${result.error}` : `Queued (${result.taskId?.slice(0, 8)}).`);
  }

  async pollForever() {
    while (!this.stopped) {
      try {
        const data = await this.call("getUpdates", { offset: this.offset, timeout: 30 });
        const updates = (Array.isArray(data.result) ? data.result : []) as { update_id: number; message?: { chat?: { id?: number }; text?: string } }[];
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message) await this.handle(u.message);
        }
      } catch (error) {
        this.deps.log("error", error instanceof Error ? error.message : String(error));
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  start() {
    void this.pollForever();
  }

  stop() {
    this.stopped = true;
  }
}
