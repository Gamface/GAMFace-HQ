import { redact } from "./guard";
import { AGENT_KEYS } from "./team";

// Telegram front end. Long-polls the Bot API; only chat IDs on the allowlist
// can run tasks. Anyone else is told their chat ID once, and nothing runs.

export interface TelegramDeps {
  submit: (prompt: string, agent: string, chatId: string) => { taskId?: string; error?: string };
  queueText: () => string;
  log: (event: string, summary: string) => void;
  /** Answers an approval request by its short code; false when it isn't waiting any more */
  decide?: (code: string, approve: boolean, scope: "once" | "card") => boolean;
  /** The approval requests that are waiting, as text */
  pendingText?: () => string;
}

interface CallbackQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat?: { id?: number | string } };
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

  /** An approval request, with Approve / Deny buttons. */
  async sendApproval(chatId: string, text: string, code: string, allowCardScope: boolean) {
    const row = [{ text: "✅ Approve", callback_data: `ap:${code}:once` }];
    if (allowCardScope) row.push({ text: "✅ This card, this site", callback_data: `ap:${code}:card` });
    row.push({ text: "❌ Deny", callback_data: `ap:${code}:deny` });
    await this.call("sendMessage", { chat_id: chatId, text: redact(text).text.slice(0, 4000), reply_markup: { inline_keyboard: [row] } }, 20000);
  }

  /** A button press on an approval message. Only allowed chats count. */
  async handleCallback(q: CallbackQuery) {
    const chatId = String(q.message?.chat?.id ?? "");
    const m = /^ap:([a-f0-9]{6}):(once|card|deny)$/.exec(q.data ?? "");
    if (!m || !this.allowed.has(chatId) || !this.deps.decide) {
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: "Not allowed" }, 10000).catch(() => {});
      return;
    }
    const ok = this.deps.decide(m[1], m[2] !== "deny", m[2] === "card" ? "card" : "once");
    const result = !ok ? "That request isn't waiting any more." : m[2] === "deny" ? "Denied." : "Approved.";
    await this.call("answerCallbackQuery", { callback_query_id: q.id, text: result }, 10000).catch(() => {});
    if (q.message) await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }, 10000).catch(() => {});
    await this.send(chatId, `${result}${ok ? ` (${m[1]})` : ""}`);
    this.deps.log("approval", `${m[2]} ${m[1]}: ${ok ? "done" : "not waiting"}`);
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
        return this.send(
          chatId,
          `Send any task and it is routed automatically. Pick an agent with /<agent> <task>: ${AGENT_KEYS.map((k) => "/" + k).join(" ")}. /status shows the queue; /approvals lists actions waiting for your OK (/approve <code>, /deny <code>).`,
        );
      }
      if (cmd === "status") return this.send(chatId, this.deps.queueText());
      if (cmd === "approvals") return this.send(chatId, this.deps.pendingText?.() || "Nothing is waiting for approval.");
      if ((cmd === "approve" || cmd === "deny") && this.deps.decide) {
        const code = (rest[0] ?? "").toLowerCase();
        if (!/^[a-f0-9]{6}$/.test(code)) return this.send(chatId, `Use /${cmd} <code>; /approvals lists what's waiting.`);
        const ok = this.deps.decide(code, cmd === "approve", "once");
        this.deps.log("approval", `${cmd} ${code}: ${ok ? "done" : "not waiting"}`);
        return this.send(chatId, ok ? `${cmd === "approve" ? "Approved" : "Denied"} (${code}).` : "That request isn't waiting any more.");
      }
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
        const data = await this.call("getUpdates", { offset: this.offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
        const updates = (Array.isArray(data.result) ? data.result : []) as { update_id: number; message?: { chat?: { id?: number }; text?: string }; callback_query?: CallbackQuery }[];
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message) await this.handle(u.message);
          if (u.callback_query) await this.handleCallback(u.callback_query);
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
