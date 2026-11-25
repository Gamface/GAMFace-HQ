// Puzzle books: logic grid puzzles and whodunit cases. The logic is all here, in code:
// a random solution, true clues drawn from it, and a solver that keeps adding clues
// until exactly one answer is left (then drops any clue that isn't needed). The model
// only writes the story around a puzzle, and it is never shown the answer, so it can't
// give it away or contradict it.

export type PuzzleType = "logic" | "mystery";
export type Difficulty = "easy" | "medium" | "hard";

export interface Category {
  name: string;
  items: string[];
  /** How a clue says someone has an item: "ordered", "was in", "had". The first category (people) has none. */
  verb?: string;
  /** Ordered categories (times, ages, prices) allow "earlier than" and "exactly 2 steps" clues */
  ordinal?: Ordinal;
}

export interface Ordinal {
  /** "arrived earlier than" */
  less: string;
  /** "arrived {n} before": {n} is the gap in the category's own units */
  by: string;
  /** The size of one step, for "by" clues ("15 minutes", "2 years") */
  step: string;
  stepValue: number;
  unit: string;
}

export type Ref = { c: number; v: number };
export type Clue =
  | { t: "same"; a: Ref; b: Ref }
  | { t: "diff"; a: Ref; b: Ref }
  | { t: "either"; a: Ref; b: Ref; d: Ref }
  | { t: "less"; a: Ref; b: Ref; o: number }
  | { t: "by"; a: Ref; b: Ref; o: number; k: number };

export interface Puzzle {
  type: PuzzleType;
  difficulty: Difficulty;
  seed: number;
  categories: Category[];
  /** solution[c][e]: the item of category c that person e has (solution[0][e] === e) */
  solution: number[][];
  clues: Clue[];
  /** Whodunits: the facts of the crime, and who did it (index into categories[0]) */
  crime?: { place: number; item: number; culprit: number; victim: string };
  /** Short descriptions for the suspects (whodunits) */
  roles?: string[];
}

// --- Random numbers you can repeat ----------------------------------------------------

export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    shuffle<T>(xs: T[]): T[] {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

// --- Solving ----------------------------------------------------------------------------

function permutations(n: number): number[][] {
  if (n === 1) return [[0]];
  const out: number[][] = [];
  for (const p of permutations(n - 1)) for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return out;
}
const PERMS = new Map<number, number[][]>();
const perms = (n: number) => PERMS.get(n) ?? (PERMS.set(n, permutations(n)), PERMS.get(n)!);

const refsOf = (cl: Clue): Ref[] => (cl.t === "either" ? [cl.a, cl.b, cl.d] : [cl.a, cl.b]);
const catsOf = (cl: Clue): number[] => [...new Set([...refsOf(cl).map((r) => r.c), ...("o" in cl ? [cl.o] : [])])];

/** Whether a clue holds, given inv[c][v] = the person who has item v of category c. */
function holds(cl: Clue, inv: number[][]): boolean {
  const who = (r: Ref) => (r.c === 0 ? r.v : inv[r.c][r.v]);
  switch (cl.t) {
    case "same":
      return who(cl.a) === who(cl.b);
    case "diff":
      return who(cl.a) !== who(cl.b);
    case "either":
      return who(cl.a) === who(cl.b) || who(cl.a) === who(cl.d);
    case "less":
    case "by": {
      // An ordinal category's items are in order, so a person's position is the item they have
      const pos = (e: number) => inv[cl.o].indexOf(e);
      const pa = pos(who(cl.a));
      const pb = pos(who(cl.b));
      return cl.t === "less" ? pa < pb : pb - pa === cl.k;
    }
  }
}

/**
 * Counts solutions, stopping at `limit`. Categories are filled in one at a time, and
 * each clue is checked as soon as every category it mentions is filled in.
 */
export function countSolutions(k: number, n: number, clues: Clue[], limit = 2): number {
  const byDepth: Clue[][] = Array.from({ length: k }, () => []);
  for (const cl of clues) byDepth[Math.max(...catsOf(cl))].push(cl);
  // inv[0] is the people themselves
  const inv: number[][] = [Array.from({ length: n }, (_, i) => i), ...Array.from({ length: k - 1 }, () => [] as number[])];
  let found = 0;
  const all = perms(n);
  const walk = (c: number) => {
    if (c === k) {
      found++;
      return;
    }
    for (const p of all) {
      inv[c] = p;
      if (byDepth[c].every((cl) => holds(cl, inv))) walk(c + 1);
      if (found >= limit) return;
    }
  };
  if (byDepth[0].every((cl) => holds(cl, inv))) walk(1);
  return found;
}

// --- Making a puzzle ---------------------------------------------------------------------

const SIZES: Record<PuzzleType, Record<Difficulty, { k: number; n: number }>> = {
  logic: { easy: { k: 3, n: 4 }, medium: { k: 4, n: 4 }, hard: { k: 4, n: 5 } },
  mystery: { easy: { k: 3, n: 4 }, medium: { k: 4, n: 4 }, hard: { k: 4, n: 5 } },
};
export const puzzleSize = (type: PuzzleType, d: Difficulty) => SIZES[type][d];

/** The categories a puzzle needs: the given ones, checked, with built-in ones filling any gaps. */
export function fitCategories(type: PuzzleType, d: Difficulty, given: Category[], seed: number): Category[] {
  const { k, n } = SIZES[type][d];
  const r = rng(seed ^ 0x5bd1e995);
  const ok = (c: Category | undefined) => c && c.items.length >= n && new Set(c.items.map((x) => x.toLowerCase())).size === c.items.length;
  const fallbacks = type === "mystery" ? MYSTERY_SETS : LOGIC_SETS;
  const out: Category[] = [];
  const people = given[0] && ok(given[0]) ? given[0] : { name: type === "mystery" ? "Suspect" : "Person", items: r.shuffle(NAMES).slice(0, n) };
  out.push({ name: people.name, items: people.items.slice(0, n) });
  // A whodunit's second and third categories are always the places and the items
  const others = type === "mystery" ? [ok(given[1]) ? { verb: "was in", ...given[1] } : fallbacks[0], ok(given[2]) ? { verb: "had", ...given[2] } : fallbacks[1]] : given.slice(1).filter((c) => ok(c) && !c.ordinal);
  const pool = type === "mystery" ? [] : r.shuffle(fallbacks);
  // Medium and hard puzzles end on an ordered category (times, ages…), which allows the harder clues
  const wantOrdinal = k >= 4;
  while (out.length < k - (wantOrdinal ? 1 : 0)) {
    const next = (others.shift() ?? pool.shift())!;
    if (type !== "mystery" && out.some((c) => c.name.toLowerCase() === next.name.toLowerCase())) continue;
    out.push({ name: next.name, verb: next.verb || "has", items: r.shuffle(next.items).slice(0, n) });
  }
  if (wantOrdinal) {
    const ords = type === "mystery" ? [ORDINALS.time] : r.shuffle(Object.values(ORDINALS));
    const o = ords[0];
    out.push({ name: o.name, verb: o.verb, items: o.items.slice(0, n), ordinal: o.ordinal });
  }
  return out;
}

/** True clues about a solution, the kinds weighted by difficulty. */
function candidateClues(cats: Category[], sol: number[][], d: Difficulty, r: ReturnType<typeof rng>): Clue[] {
  const k = cats.length;
  const n = cats[0].items.length;
  const has = (c: number, e: number): Ref => ({ c, v: sol[c][e] });
  const out: { cl: Clue; w: number }[] = [];
  const weight = { same: { easy: 5, medium: 2, hard: 1 }, diff: { easy: 2, medium: 3, hard: 3 }, either: { easy: 0, medium: 2, hard: 3 }, less: { easy: 0, medium: 2, hard: 3 }, by: { easy: 0, medium: 1, hard: 2 } };
  const ord = cats.findIndex((c) => c.ordinal);
  for (let c1 = 0; c1 < k; c1++)
    for (let c2 = c1 + 1; c2 < k; c2++)
      for (let e = 0; e < n; e++) {
        out.push({ cl: { t: "same", a: has(c1, e), b: has(c2, e) }, w: weight.same[d] });
        for (let f = 0; f < n; f++) {
          if (f === e) continue;
          out.push({ cl: { t: "diff", a: has(c1, e), b: has(c2, f) }, w: weight.diff[d] / (n - 1) });
          // "A is either B (true) or C (false)", both options from one other category
          if (weight.either[d]) {
            const pair = r.next() < 0.5 ? [has(c2, e), has(c2, f)] : [has(c2, f), has(c2, e)];
            out.push({ cl: { t: "either", a: has(c1, e), b: pair[0], d: pair[1] }, w: weight.either[d] / (n - 1) });
          }
        }
      }
  if (ord >= 0) {
    const pos = (e: number) => sol[ord][e];
    for (let c1 = 0; c1 < k; c1++)
      for (let c2 = 0; c2 < k; c2++) {
        if (c1 === ord || c2 === ord) continue;
        for (let e = 0; e < n; e++)
          for (let f = 0; f < n; f++) {
            if (e === f || pos(e) >= pos(f)) continue;
            out.push({ cl: { t: "less", a: has(c1, e), b: has(c2, f), o: ord }, w: weight.less[d] / n });
            out.push({ cl: { t: "by", a: has(c1, e), b: has(c2, f), o: ord, k: pos(f) - pos(e) }, w: weight.by[d] / n });
          }
      }
  }
  // Weighted shuffle: each clue gets a random key scaled by its weight
  return out
    .filter((x) => x.w > 0)
    .map((x) => ({ cl: x.cl, key: Math.pow(r.next(), 1 / x.w) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.cl);
}

const breathe = () => new Promise<void>((r) => setImmediate(r));

/**
 * Makes a puzzle with exactly one solution. A hard one takes a few seconds of solving,
 * so it pauses between solver runs to keep the server answering.
 */
export async function makePuzzle(type: PuzzleType, difficulty: Difficulty, categories: Category[], seed: number, extra: { victim?: string; roles?: string[] } = {}): Promise<Puzzle> {
  const cats = fitCategories(type, difficulty, categories, seed);
  const k = cats.length;
  const n = cats[0].items.length;
  const r = rng(seed);
  const solution = [Array.from({ length: n }, (_, i) => i), ...cats.slice(1).map(() => r.shuffle(Array.from({ length: n }, (_, i) => i)))];
  const pool = candidateClues(cats, solution, difficulty, r);
  // Add clues until one answer is left
  const clues: Clue[] = [];
  for (const cl of pool) {
    clues.push(cl);
    if (countSolutions(k, n, clues) === 1) break;
    await breathe();
  }
  if (countSolutions(k, n, clues) !== 1) throw new Error("Couldn't make a puzzle with one answer");
  // Drop clues that aren't needed, last first
  for (let i = clues.length - 1; i >= 0; i--) {
    const without = clues.filter((_, j) => j !== i);
    if (countSolutions(k, n, without) === 1) clues.splice(i, 1);
    await breathe();
  }
  const puzzle: Puzzle = { type, difficulty, seed, categories: cats, solution, clues: r.shuffle(clues) };
  if (type === "mystery") {
    const culprit = r.int(n);
    // The crime's place and weapon are the culprit's, so solving the grid names them
    puzzle.crime = { culprit, place: solution[1][culprit], item: solution[2][culprit], victim: extra.victim || "the victim" };
    puzzle.roles = extra.roles?.slice(0, n);
  }
  return puzzle;
}

// --- Words -----------------------------------------------------------------------------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Alice", or "the suspect who was in the Library". */
function subject(p: Puzzle, ref: Ref): string {
  const cat = p.categories[ref.c];
  const item = cat.items[ref.v];
  if (ref.c === 0) return item;
  const who = p.type === "mystery" ? "the suspect" : "the person";
  return `${who} who ${cat.verb || "has"} ${item}`;
}

/** One clue in plain English. */
export function clueText(p: Puzzle, cl: Clue): string {
  const s = (r: Ref) => subject(p, r);
  switch (cl.t) {
    case "same": {
      const cat = p.categories[cl.b.c];
      return cl.b.c === 0 ? `${cap(s(cl.a))} is ${cat.items[cl.b.v]}.` : `${cap(s(cl.a))} ${cat.verb || "has"} ${cat.items[cl.b.v]}.`;
    }
    case "diff":
      return `${cap(s(cl.a))} is not ${s(cl.b)}.`;
    case "either":
      return `${cap(s(cl.a))} is either ${s(cl.b)} or ${s(cl.d)}.`;
    case "less":
      return `${cap(s(cl.a))} ${p.categories[cl.o].ordinal!.less} ${s(cl.b)}.`;
    case "by": {
      const o = p.categories[cl.o].ordinal!;
      const gap = `${cl.k * o.stepValue} ${o.unit}${cl.k * o.stepValue === 1 ? "" : "s"}`;
      return `${cap(s(cl.a))} ${o.by.replace("{n}", gap)} ${s(cl.b)}.`;
    }
  }
}

/** The answer as rows: one per person, each with their item from every category. */
export function answerRows(p: Puzzle): string[][] {
  return p.categories[0].items.map((_, e) => p.categories.map((c, ci) => c.items[p.solution[ci][e]]));
}

/** What the story writer may know: the setting and everyone in it, never the answer. */
export function puzzleFacts(p: Puzzle): string {
  const lines = p.categories.map((c, i) => `${i === 0 ? (p.type === "mystery" ? "Suspects" : "People") : c.name}: ${c.items.join(", ")}`);
  if (p.roles?.length) lines.push(`Who they are: ${p.categories[0].items.map((x, i) => `${x} (${p.roles![i] ?? "a guest"})`).join("; ")}`);
  if (p.crime) lines.push(`The crime: ${p.crime.victim} was found in ${p.categories[1].items[p.crime.place]}, killed with ${p.categories[2].items[p.crime.item]}.`);
  return lines.join("\n");
}

const htmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The classic solving grid as an XHTML-safe table: people and the other categories down
 * the side, every other category across the top, one block per pair of categories.
 */
export function gridHtml(p: Puzzle): string {
  const k = p.categories.length;
  const cols = Array.from({ length: k - 1 }, (_, i) => i + 1);
  const rows = [0, ...Array.from({ length: k - 2 }, (_, i) => k - 1 - i)];
  const head1 = `<tr><th class="corner" colspan="2"></th>${cols.map((c) => `<th class="cat" colspan="${p.categories[c].items.length}">${htmlEsc(p.categories[c].name)}</th>`).join("")}</tr>`;
  const head2 = `<tr><th class="corner" colspan="2"></th>${cols.map((c) => p.categories[c].items.map((x) => `<th class="item"><span>${htmlEsc(x)}</span></th>`).join("")).join("")}</tr>`;
  const body = rows
    .map((r) =>
      p.categories[r].items
        .map(
          (x, i) =>
            `<tr>${i === 0 ? `<th class="cat side" rowspan="${p.categories[r].items.length}"><span>${htmlEsc(r === 0 ? p.categories[0].name : p.categories[r].name)}</span></th>` : ""}<th class="row">${htmlEsc(x)}</th>` +
            cols.map((c) => p.categories[c].items.map(() => (r === 0 || c < r ? `<td></td>` : `<td class="off"></td>`)).join("")).join("") +
            `</tr>`,
        )
        .join(""),
    )
    .join("");
  return `<table class="grid">${head1}${head2}${body}</table>`;
}

/** The puzzle's page (after the story): what you're told, the clues and the grid. */
export function puzzleHtml(p: Puzzle): string {
  const crime = p.crime
    ? `<p class="crime"><strong>The facts:</strong> ${htmlEsc(p.crime.victim)} was found in ${htmlEsc(p.categories[1].items[p.crime.place])}, killed with ${htmlEsc(p.categories[2].items[p.crime.item])}. Each suspect was in a different place, had a different item${p.categories.length > 3 ? ` and ${htmlEsc(p.categories[3].verb ?? "")} at a different time` : ""}.</p>`
    : `<p class="crime">Each ${p.categories[0].name.toLowerCase()} matches exactly one item in every category.</p>`;
  const suspects = p.roles?.length ? `<ul class="suspects">${p.categories[0].items.map((x, i) => `<li><strong>${htmlEsc(x)}</strong>${p.roles![i] ? ` — ${htmlEsc(p.roles![i])}` : ""}</li>`).join("")}</ul>` : "";
  const question = p.crime ? `<p class="question"><strong>Who did it?</strong> Work out where everyone was and what they had.</p>` : "";
  return (
    `<div class="puzzle">${suspects}${crime}<h3>Clues</h3><ol class="clues">${p.clues.map((c) => `<li>${htmlEsc(clueText(p, c))}</li>`).join("")}</ol>${question}` +
    `<div class="grid-wrap">${gridHtml(p)}</div></div>`
  );
}

/** One answer in the answer key. */
export function answerHtml(p: Puzzle, title: string, n: number): string {
  const rows = answerRows(p);
  const culprit = p.crime ? `<p><strong>${htmlEsc(p.categories[0].items[p.crime.culprit])} did it</strong>, in ${htmlEsc(p.categories[1].items[p.crime.place])} with ${htmlEsc(p.categories[2].items[p.crime.item])}.</p>` : "";
  return (
    `<div class="answer"><h3>${n}. ${htmlEsc(title)}</h3>${culprit}<table class="answers"><tr>${p.categories.map((c) => `<th>${htmlEsc(c.name)}</th>`).join("")}</tr>` +
    rows.map((r) => `<tr>${r.map((x) => `<td>${htmlEsc(x)}</td>`).join("")}</tr>`).join("") +
    `</table></div>`
  );
}

export const PUZZLE_CSS = `
.puzzle h3 { margin-top: 0.8em; }
.crime, .question { text-indent: 0; margin: 0.6em 0; }
ol.clues { margin: 0.4em 0 0.8em 1.4em; }
ol.clues li { margin: 0.25em 0; }
ul.suspects { list-style: none; margin: 0.4em 0; padding: 0; }
.grid-wrap { margin-top: 1em; page-break-inside: avoid; break-inside: avoid; }
table.grid { border-collapse: collapse; width: auto; font-size: 0.8em; font-family: Arial, Helvetica, sans-serif; }
table.grid td, table.grid th { border: 1px solid #333; padding: 0; }
table.grid td { width: 1.9em; height: 1.9em; }
table.grid td.off, table.grid th.corner { border: none; background: none; }
table.grid th.item { height: 7em; vertical-align: bottom; white-space: nowrap; }
table.grid th.item span { display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg); padding: 0.2em 0; }
table.grid th.side span { display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg); }
table.grid th.row { text-align: right; padding: 0 0.4em; white-space: nowrap; font-weight: normal; }
table.grid th.cat { background: #eee; padding: 0.2em; }
table.answers { font-size: 0.85em; margin-bottom: 1em; }
.answer h3 { margin-bottom: 0.3em; }
`;

// --- Built-in names and categories (used when the model's are missing or unusable) -------

const NAMES = ["Alice", "Ben", "Clara", "Daniel", "Eva", "Felix", "Grace", "Hugo", "Iris", "Jack", "Lena", "Marco", "Nora", "Oscar", "Priya", "Quinn", "Rosa", "Sam", "Tara", "Victor"];

const LOGIC_SETS: Category[] = [
  { name: "Pet", verb: "owns", items: ["a cat", "a dog", "a parrot", "a rabbit", "a hamster", "a tortoise"] },
  { name: "Drink", verb: "ordered", items: ["tea", "coffee", "lemonade", "cocoa", "juice", "milk"] },
  { name: "Hobby", verb: "enjoys", items: ["painting", "chess", "gardening", "cycling", "baking", "knitting"] },
  { name: "Colour", verb: "wore", items: ["red", "blue", "green", "yellow", "purple", "orange"] },
  { name: "City", verb: "lives in", items: ["Paris", "Lisbon", "Oslo", "Vienna", "Dublin", "Prague"] },
  { name: "Dessert", verb: "chose", items: ["cheesecake", "brownies", "apple pie", "tiramisu", "sorbet", "fudge"] },
];

const MYSTERY_SETS: Category[] = [
  { name: "Room", verb: "was in", items: ["the Library", "the Kitchen", "the Ballroom", "the Conservatory", "the Study", "the Cellar"] },
  { name: "Item", verb: "had", items: ["the candlestick", "the rope", "the letter opener", "the poison vial", "the wrench", "the revolver"] },
];

const ORDINALS: Record<string, { name: string; verb: string; items: string[]; ordinal: Ordinal }> = {
  time: {
    name: "Time",
    verb: "arrived at",
    items: ["7:00 pm", "7:15 pm", "7:30 pm", "7:45 pm", "8:00 pm", "8:15 pm"],
    ordinal: { less: "arrived earlier than", by: "arrived exactly {n} before", step: "15 minutes", stepValue: 15, unit: "minute" },
  },
  age: {
    name: "Age",
    verb: "is aged",
    items: ["21", "24", "27", "30", "33", "36"],
    ordinal: { less: "is younger than", by: "is exactly {n} younger than", step: "3 years", stepValue: 3, unit: "year" },
  },
  price: {
    name: "Price",
    verb: "paid",
    items: ["$5", "$10", "$15", "$20", "$25", "$30"],
    ordinal: { less: "paid less than", by: "paid exactly {n} less than", step: "5 dollars", stepValue: 5, unit: "dollar" },
  },
};
