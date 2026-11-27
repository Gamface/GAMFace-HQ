// Activity puzzles for puzzle books: word searches and sudoku, made and checked in code (ported
// from ods-Jarvis's book studio). A word search hides the model's themed words in a letter
// grid; a sudoku is a full grid with cells taken away only while it still has one solution.

import type { Difficulty } from "./puzzles";

type Rng = { next: () => number; int: (n: number) => number; shuffle: <T>(a: T[]) => T[] };

export interface Placement {
  word: string;
  r: number;
  c: number;
  dr: number;
  dc: number;
}

export const WS_SIZE: Record<Difficulty, number> = { easy: 12, medium: 15, hard: 17 };
/** How many words to ask the model for */
export const WS_WORDS: Record<Difficulty, number> = { easy: 10, medium: 15, hard: 20 };
const WS_DIRS: Record<Difficulty, [number, number][]> = {
  easy: [
    [0, 1],
    [1, 0],
  ],
  medium: [
    [0, 1],
    [1, 0],
    [1, 1],
    [-1, 1],
  ],
  hard: [
    [0, 1],
    [1, 0],
    [1, 1],
    [-1, 1],
    [0, -1],
    [-1, 0],
    [-1, -1],
    [1, -1],
  ],
};
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Words as they go in the grid: A-Z only, 3 letters up to the grid's width, no repeats. */
export function cleanWords(words: unknown[], size: number): string[] {
  const out: string[] = [];
  for (const w of words) {
    const k = String(w ?? "")
      .normalize("NFKD")
      .toUpperCase()
      .replace(/[^A-Z]/g, "");
    if (k.length >= 3 && k.length <= size && !out.includes(k)) out.push(k);
  }
  return out;
}

export function makeWordsearch(words: unknown[], difficulty: Difficulty, r: Rng): { grid: string[]; words: string[]; placed: Placement[] } {
  const n = WS_SIZE[difficulty];
  const clean = cleanWords(words, n)
    .sort((a, b) => b.length - a.length)
    .slice(0, 24);
  if (clean.length < 4) throw new Error("A word search needs at least 4 words of 3 or more letters");
  let best: { grid: string[][]; placed: Placement[] } = { grid: [], placed: [] };
  for (let attempt = 0; attempt < 40; attempt++) {
    const grid = Array.from({ length: n }, () => Array<string>(n).fill(""));
    const placed: Placement[] = [];
    for (const w of clean) {
      const spots: Placement[] = [];
      for (const [dr, dc] of WS_DIRS[difficulty])
        for (let row = 0; row < n; row++)
          for (let col = 0; col < n; col++) {
            const er = row + dr * (w.length - 1);
            const ec = col + dc * (w.length - 1);
            if (er >= 0 && er < n && ec >= 0 && ec < n) spots.push({ word: w, r: row, c: col, dr, dc });
          }
      for (const s of r.shuffle(spots)) {
        if ([...w].every((ch, i) => ["", ch].includes(grid[s.r + s.dr * i][s.c + s.dc * i]))) {
          [...w].forEach((ch, i) => (grid[s.r + s.dr * i][s.c + s.dc * i] = ch));
          placed.push(s);
          break;
        }
      }
    }
    if (placed.length > best.placed.length) best = { grid, placed };
    if (placed.length === clean.length) break;
  }
  const grid = best.grid.map((row) => row.map((ch) => ch || LETTERS[r.int(26)]).join(""));
  return { grid, words: best.placed.map((p) => p.word).sort(), placed: best.placed };
}

// --- Sudoku ------------------------------------------------------------------------------

const SUDOKU_GIVENS: Record<Difficulty, number> = { easy: 40, medium: 32, hard: 26 };
const PEERS: number[][] = Array.from({ length: 81 }, (_, i) => {
  const row = Math.floor(i / 9);
  const col = i % 9;
  const br = Math.floor(row / 3) * 3;
  const bc = Math.floor(col / 3) * 3;
  const s = new Set<number>();
  for (let k = 0; k < 9; k++) {
    s.add(row * 9 + k);
    s.add(k * 9 + col);
    s.add((br + Math.floor(k / 3)) * 9 + bc + (k % 3));
  }
  s.delete(i);
  return [...s];
});

/** Up to `limit` solutions of a grid (0 = empty). */
export function solveSudoku(cells: number[], limit: number, r?: Rng): number[][] {
  const g = [...cells];
  const sols: number[][] = [];
  const rec = (): void => {
    let best = -1;
    let bestOpts: number[] | null = null;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const used = new Set(PEERS[i].map((p) => g[p]));
      const opts = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((v) => !used.has(v));
      if (!opts.length) return;
      if (!bestOpts || opts.length < bestOpts.length) {
        best = i;
        bestOpts = opts;
        if (opts.length === 1) break;
      }
    }
    if (best < 0) {
      sols.push([...g]);
      return;
    }
    for (const v of r ? r.shuffle(bestOpts!) : bestOpts!) {
      g[best] = v;
      rec();
      if (sols.length >= limit) return;
    }
    g[best] = 0;
  };
  rec();
  return sols;
}

export function makeSudoku(difficulty: Difficulty, r: Rng): { givens: number[]; answer: number[] } {
  const answer = solveSudoku(Array(81).fill(0), 1, r)[0];
  const givens = [...answer];
  let filled = 81;
  for (const i of r.shuffle(Array.from({ length: 81 }, (_, k) => k))) {
    if (filled <= SUDOKU_GIVENS[difficulty]) break;
    const keep = givens[i];
    givens[i] = 0;
    if (solveSudoku(givens, 2).length !== 1) givens[i] = keep;
    else filled--;
  }
  return { givens, answer };
}

// --- Pages ------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The letter grid; with `found`, the hidden words' letters are shaded (answer key). */
export function wordsearchHtml(grid: string[], words: string[], placed?: Placement[], small = false): string {
  const hit = new Set<string>();
  for (const p of placed ?? []) for (let i = 0; i < p.word.length; i++) hit.add(`${p.r + p.dr * i},${p.c + p.dc * i}`);
  const rows = grid.map((row, ri) => `<tr>${[...row].map((ch, ci) => `<td${hit.has(`${ri},${ci}`) ? ' class="hit"' : ""}>${ch}</td>`).join("")}</tr>`).join("");
  return (
    `<table class="ws${small ? " small" : ""}">${rows}</table>` +
    (placed ? "" : `<ul class="words">${words.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`)
  );
}

export function sudokuHtml(cells: number[], small = false): string {
  const rows = Array.from({ length: 9 }, (_, r) => `<tr>${Array.from({ length: 9 }, (_, c) => `<td>${cells[r * 9 + c] || ""}</td>`).join("")}</tr>`).join("");
  return `<table class="sudoku${small ? " small" : ""}">${rows}</table>`;
}

export const ACTIVITY_CSS = `
table.ws { border-collapse: collapse; margin: 0.6em auto; font-family: "Courier New", monospace; font-weight: bold; }
table.ws td { width: 1.55em; height: 1.55em; text-align: center; vertical-align: middle; font-size: 1.05em; padding: 0; }
table.ws.small td { width: 1.1em; height: 1.1em; font-size: 0.7em; }
table.ws td.hit { background: #d9d9d9; }
ul.words { columns: 3; list-style: none; padding: 0; margin: 0.8em auto; max-width: 30em; font-family: Arial, Helvetica, sans-serif; font-size: 0.95em; }
ul.words li { margin: 0.15em 0; }
table.sudoku { border-collapse: collapse; margin: 0.8em auto; font-family: Arial, Helvetica, sans-serif; border: 2.5px solid #111; }
table.sudoku td { width: 2.1em; height: 2.1em; border: 1px solid #777; text-align: center; vertical-align: middle; font-size: 1.25em; padding: 0; }
table.sudoku.small td { width: 1.25em; height: 1.25em; font-size: 0.75em; }
table.sudoku tr:nth-child(3n) td { border-bottom: 2.5px solid #111; }
table.sudoku td:nth-child(3n) { border-right: 2.5px solid #111; }
.answer-small { display: inline-block; vertical-align: top; margin: 0 1em 1em 0; text-align: center; page-break-inside: avoid; break-inside: avoid; }
`;
