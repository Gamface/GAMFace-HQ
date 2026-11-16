// Line diffs for the change history: Myers' algorithm, shown as unified hunks.

export type DiffLine = { op: " " | "+" | "-"; text: string; a?: number; b?: number };
export interface Hunk {
  aStart: number;
  aLines: number;
  bStart: number;
  bLines: number;
  lines: DiffLine[];
}

const MAX_LINES = 20_000;

export const splitLines = (s: string): string[] => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** The edit script turning a into b (Myers O(ND)). */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  // Common head and tail first: most edits are small
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const n = A.length;
  const m = B.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk back through the trace
  const mid: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[max + k - 1] < vd[max + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[max + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) mid.push({ op: " ", text: A[--x] }), y--;
    if (d > 0) {
      if (x === prevX) mid.push({ op: "+", text: B[--y] });
      else mid.push({ op: "-", text: A[--x] });
    }
  }
  while (x > 0 && y > 0) mid.push({ op: " ", text: A[--x] }), y--;
  mid.reverse();
  const out: DiffLine[] = [...a.slice(0, head).map((t) => ({ op: " " as const, text: t })), ...mid, ...a.slice(a.length - tail).map((t) => ({ op: " " as const, text: t }))];
  // Line numbers
  let ai = 1;
  let bi = 1;
  for (const l of out) {
    if (l.op !== "+") l.a = ai++;
    if (l.op !== "-") l.b = bi++;
  }
  return out;
}

/** Unified-diff hunks with `context` unchanged lines around each change. */
export function hunks(before: string, after: string, context = 3): { hunks: Hunk[]; added: number; removed: number; tooBig: boolean } {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return { hunks: [], added: b.length, removed: a.length, tooBig: true };
  const lines = diffLines(a, b);
  const added = lines.filter((l) => l.op === "+").length;
  const removed = lines.filter((l) => l.op === "-").length;
  const out: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op === " ") {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    // Extend while the next change is within 2×context lines
    while (end < lines.length) {
      if (lines[end].op !== " ") {
        end++;
        continue;
      }
      let j = end;
      while (j < lines.length && lines[j].op === " " && j - end < context * 2) j++;
      if (j < lines.length && lines[j].op !== " ") end = j;
      else break;
    }
    const stop = Math.min(lines.length, end + context);
    const slice = lines.slice(start, stop);
    const firstA = slice.find((l) => l.a !== undefined)?.a ?? (lines.slice(0, start).filter((l) => l.a !== undefined).pop()?.a ?? 0) + 1;
    const firstB = slice.find((l) => l.b !== undefined)?.b ?? (lines.slice(0, start).filter((l) => l.b !== undefined).pop()?.b ?? 0) + 1;
    out.push({
      aStart: firstA,
      aLines: slice.filter((l) => l.op !== "+").length,
      bStart: firstB,
      bLines: slice.filter((l) => l.op !== "-").length,
      lines: slice,
    });
    i = stop;
  }
  return { hunks: out, added, removed, tooBig: false };
}

/** Plain-text unified diff (for logs and tests). */
export function unified(path: string, before: string | null, after: string | null): string {
  const h = hunks(before ?? "", after ?? "");
  const head = `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ ${after === null ? "/dev/null" : `b/${path}`}\n`;
  return head + h.hunks.map((x) => `@@ -${x.aStart},${x.aLines} +${x.bStart},${x.bLines} @@\n${x.lines.map((l) => l.op + l.text).join("\n")}`).join("\n") + "\n";
}
