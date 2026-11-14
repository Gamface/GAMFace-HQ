// Exfiltration guard: redacts secrets from anything the agents send out
// (the dashboard stream, Telegram replies, saved notes).

const PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["anthropic key", /sk-ant-[A-Za-z0-9_\-]{20,}/g],
  ["openai key", /sk-(?:proj-)?[A-Za-z0-9_\-]{20,}/g],
  ["github token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{40,}/g],
  ["google key", /\bAIza[0-9A-Za-z_\-]{35}\b/g],
  ["aws key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g],
  ["telegram token", /\b\d{8,10}:[A-Za-z0-9_\-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g],
];
const ASSIGNMENT = /\b(password|passwd|secret|api[_-]?key|token)(\s*[:=]\s*)['"]?[^\s'"]{6,}['"]?/gi;

export function redact(text: string): { text: string; found: string[] } {
  const found: string[] = [];
  for (const [label, pattern] of PATTERNS) {
    if (text.match(pattern)) {
      found.push(label);
      text = text.replace(pattern, `[REDACTED ${label}]`);
    }
  }
  if (text.match(ASSIGNMENT)) {
    found.push("password assignment");
    text = text.replace(ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  }
  return { text, found };
}

/**
 * Streams text through the guard. A secret can be split across two token
 * batches, so the tail of each batch is held back until the next one (or the
 * end) arrives, and the cut is made at whitespace, which secrets don't contain.
 */
export class StreamGuard {
  private held = "";
  found = new Set<string>();
  private holdBack: number;

  constructor(holdBack = 200) {
    this.holdBack = holdBack;
  }

  push(chunk: string): string {
    const raw = this.held + chunk;
    if (raw.length <= this.holdBack) {
      this.held = raw;
      return "";
    }
    let cut = raw.lastIndexOf(" ", raw.length - this.holdBack);
    const nl = raw.lastIndexOf("\n", raw.length - this.holdBack);
    cut = Math.max(cut, nl);
    if (cut <= 0) {
      this.held = raw;
      return "";
    }
    this.held = raw.slice(cut);
    return this.clean(raw.slice(0, cut));
  }

  end(): string {
    const rest = this.held;
    this.held = "";
    return this.clean(rest);
  }

  private clean(text: string) {
    const out = redact(text);
    out.found.forEach((f) => this.found.add(f));
    return out.text;
  }
}
