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

// --- Does a text carry private material? ---------------------------------------------------
// A lead that saw private material writes handoffs; most don't repeat any of it ("get tonight's
// NBA odds"). carriedPrivate() looks for what would actually leak: names and other proper nouns,
// specific numbers and identifiers, and copied phrases, that appear in the private material but
// nowhere public (the user's own request, the instructions, the tool list). It can't see a
// paraphrase in plain words ("has a peanut allergy" from "allergic to peanuts"), so the
// "Tool calls from private context" setting is still there for those who want every call to ask.

/**
 * The private material in texts (inside blocks, or after a block cut off) and what a cloud model
 * would see. `personal` is the private material without the hive log: memories, vault notes and
 * private skills, where plain-language facts about the user live (the hive log is mostly the
 * agents' own wording from earlier cards).
 */
export function splitPrivate(texts: string[]): { private: string; personal: string; public: string } {
  const priv: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(BLOCK)) priv.push(m[1]);
    const rest = t.replace(BLOCK, "");
    const cut = rest.indexOf(OPEN);
    if (cut >= 0) priv.push(rest.slice(cut + OPEN.length));
  }
  const clean = (list: string[]) => list.join("\n").replace(MARKER_CHARS, "");
  return {
    private: clean(priv),
    personal: clean(priv.filter((p) => !/^\s*HIVE MIND\b/.test(p))),
    public: texts.map((t) => resolvePrivate(t, false).text).join("\n"),
  };
}

const TOKEN = /[\p{L}\p{N}](?:[\p{L}\p{N}'’@._:/-]*[\p{L}\p{N}])?/gu;
const tokens = (text: string) => text.match(TOKEN) ?? [];
// Lower case, one apostrophe, and no possessive ("Patel's" matches "Patel")
const norm = (t: string) => t.toLowerCase().replace(/[’']/g, "'").replace(/'s$/, "");
// Capitalised words that are ordinary English, not names
const COMMON_CAPS = new Set(
  "i the a an and or but if then so this that these those it its we you he she they my your our their his her me us them what when where who why how which there here yes no not all any some each every many more most other such only also just very can will would should could may might must do does did done is are was were be been being has have had get got make made use used please thanks hello hi ok okay note notes today tomorrow yesterday monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december request context memory memories hive mind team jarvis user assistant".split(
    " ",
  ),
);

// Everyday words: a copied phrase made only of these (and public words) reveals nothing
const COMMON = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing done down during each few for from further get gets getting got had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours " +
    "use using used find found search searched look check get give show tell list return returns make made take want need please help try call ask answer result results data information info details detail item items thing things way ways method methods step steps tool tools teammate team task request report summary summarize combined combine latest current recent new old today tonight tomorrow yesterday week month year time times day days number numbers first last next one two three four five many much each every full part page pages link links source sources"
  ).split(/\s+/),
);

/** Words used as names in a text: capitalised, not at the start of a sentence, not ordinary English. */
function properNouns(text: string): Set<string> {
  const out = new Set<string>();
  // Preceded by a word on the same line, not by a sentence end, a colon or a list bullet
  for (const m of text.matchAll(/(?<=[^.!?:\-•*\s][ \t]+)([\p{Lu}][\p{L}'’-]{1,})/gu)) {
    const w = norm(m[1]);
    if (!COMMON_CAPS.has(w)) out.add(w);
  }
  return out;
}

/** Numbers and identifiers worth protecting: 3+ digit numbers (not years), emails, links, paths, codes. */
const specific = (t: string) => /@|https?:|www\.|\/|\d{3,}|[a-z]+\d+|\d+[a-z]+/i.test(t) && !/^(19|20)\d\d$/.test(t);

/**
 * What a handoff repeats from the private material (empty: nothing). Exported for tests.
 * `privateText` is what the lead saw privately (checked for names, numbers and identifiers);
 * `personalText` the part checked for copied phrases (defaults to all of it); `publicText`
 * everything it saw that isn't private.
 */
export function carriedPrivate(handoff: string, privateText: string, publicText: string, personalText = privateText): string[] {
  const pubTokens = new Set(tokens(publicText).map(norm));
  const privTokens = new Set(tokens(privateText).map(norm));
  // "espn.scores" is public when "espn" and "scores" are (the tool list says "espn: scores")
  const isPublic = (t: string) => pubTokens.has(t) || (/[.:/_-]/.test(t) && !/@|\d{3,}/.test(t) && t.split(/[.:/_-]+/).filter(Boolean).every((p) => pubTokens.has(p) || COMMON.has(p)));
  const names = properNouns(privateText);
  const found = new Set<string>();
  const words = tokens(handoff);
  for (const raw of words) {
    const t = norm(raw);
    if (isPublic(t) || !privTokens.has(t)) continue;
    if (names.has(t) || specific(t)) found.add(raw);
  }
  // A phrase of five words copied from the private material and not from anything public, with
  // at least one word that appears nowhere public (a phrase made only of public words, like the
  // lead's own earlier handoff in the hive log, reveals nothing)
  const seq = (text: string) => tokens(text).map(norm).join(" ");
  const privSeq = ` ${seq(personalText)} `;
  const pubSeq = ` ${seq(publicText)} `;
  const lower = words.map(norm);
  for (let i = 0; i + 5 <= lower.length; i++) {
    const five = lower.slice(i, i + 5);
    const phrase = five.join(" ");
    if (!five.some((w) => !isPublic(w) && !COMMON.has(w))) continue;
    if (privSeq.includes(` ${phrase} `) && !pubSeq.includes(` ${phrase} `)) found.add(`“${words.slice(i, i + 5).join(" ")}”`);
  }
  return [...found].slice(0, 6);
}
