// Private material (vault notes, memories, the hive log, and anything an agent
// wrote after seeing those) is wrapped in markers where it enters a prompt.
// The model gateway (gateway.ts) resolves every marker just before a request
// leaves: local models get the full text, cloud models get the public stand-in,
// unless that agent is explicitly allowed to send private context to the cloud.
//
// Markers use characters that are stripped from all wrapped content, so text
// from a web page or a memory can't close a block early and leak what follows.

const OPEN = "⟦P⟧";
const MID = "⟦/P-PUBLIC⟧";
const CLOSE = "⟦/P⟧";
const MARKER_CHARS = /[⟦⟧]/g;
const BLOCK = /⟦P⟧([\s\S]*?)⟦\/P-PUBLIC⟧([\s\S]*?)⟦\/P⟧/g;

/** Wraps private text. `publicText` is what a cloud model sees instead (can be empty). */
export function privateBlock(full: string, publicText = ""): string {
  return OPEN + full.replace(MARKER_CHARS, "") + MID + publicText.replace(MARKER_CHARS, "") + CLOSE;
}

/** Removes marker characters from untrusted text before it is placed in a prompt. */
export function sanitize(text: string): string {
  return text.replace(MARKER_CHARS, "");
}

export function hasPrivate(text: string): boolean {
  BLOCK.lastIndex = 0;
  return BLOCK.test(text);
}

/** Resolves every block: full text when allowed, the public stand-in otherwise. Always strips stray markers. */
export function resolvePrivate(text: string, allowPrivate: boolean): { text: string; hadPrivate: boolean } {
  let hadPrivate = false;
  let out = text.replace(BLOCK, (_m, full: string, pub: string) => {
    hadPrivate = true;
    return allowPrivate ? full : pub;
  });
  // A block that was cut off (its end marker lost to truncation) is still private:
  // without permission, everything from its start is withheld.
  const cut = out.indexOf(OPEN);
  if (cut >= 0) {
    hadPrivate = true;
    if (!allowPrivate) out = `${out.slice(0, cut)} (private content withheld)`;
  }
  return { text: out.replace(MARKER_CHARS, ""), hadPrivate };
}
