import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanWords, makeSudoku, makeWordsearch, solveSudoku } from "../src/hq/activity";
import { answerHtml, makePuzzle, puzzleFacts, puzzleHtml, puzzleReady, rng } from "../src/hq/puzzles";
import { bookHtml, bookMarkdown, newBook, nextStep, runStep, type Book } from "../src/hq/books";

test("word search: every word is in the grid where it says", () => {
  const words = ["Lion", "Tiger", "Zebra", "Giraffe", "Hippo", "Rhino", "Cheetah", "Monkey", "Parrot", "Elephant"];
  for (const d of ["easy", "medium", "hard"] as const) {
    const ws = makeWordsearch(words, d, rng(7));
    const n = ws.grid.length;
    assert.ok(ws.grid.every((r) => r.length === n && /^[A-Z]+$/.test(r)));
    assert.ok(ws.words.length >= 8, `${d}: ${ws.words.length} words placed`);
    for (const p of ws.placed) assert.equal([...p.word].map((_, i) => ws.grid[p.r + p.dr * i][p.c + p.dc * i]).join(""), p.word);
    if (d === "easy") assert.ok(ws.placed.every((p) => (p.dr === 0 && p.dc === 1) || (p.dr === 1 && p.dc === 0)), "easy: across and down only");
  }
  assert.deepEqual(cleanWords(["Ice cream!", "ox", "Crème", "ICECREAM"], 12), ["ICECREAM", "CREME"]);
  assert.throws(() => makeWordsearch(["ab", "cd"], "easy", rng(1)), /at least 4 words/);
});

test("sudoku: one solution, as many givens as the difficulty says", () => {
  const { givens, answer } = makeSudoku("hard", rng(3));
  assert.equal(givens.length, 81);
  assert.ok(givens.filter(Boolean).length <= 30);
  const sols = solveSudoku(givens, 2);
  assert.equal(sols.length, 1);
  assert.deepEqual(sols[0], answer);
  for (let r = 0; r < 9; r++) assert.equal(new Set(answer.slice(r * 9, r * 9 + 9)).size, 9);
});

test("activity puzzles render and are never shown the answer before the key", async () => {
  const ws = await makePuzzle("wordsearch", "medium", [], 5, { words: ["apple", "banana", "cherry", "grape", "lemon", "mango"] });
  assert.ok(puzzleReady(ws));
  assert.match(puzzleFacts(ws), /APPLE/);
  assert.match(puzzleHtml(ws), /class="ws"/);
  assert.doesNotMatch(puzzleHtml(ws), /class="hit"/, "the puzzle page doesn't shade the words");
  assert.match(answerHtml(ws, "Fruit", 1), /class="hit"/);
  const su = await makePuzzle("sudoku", "easy", [], 9);
  assert.ok(puzzleReady(su));
  const page = puzzleHtml(su);
  assert.equal((page.match(/<td>\d<\/td>/g) ?? []).length, su.givens!.filter(Boolean).length);
});

test("a sudoku book is planned, outlined and made without a model", async () => {
  const made = newBook({ title: "Sudoku Nights", kind: "puzzle", puzzleType: "sudoku", difficulty: "easy", brief: "Easy sudoku for relaxing evenings", chapterCount: 3 });
  assert.ok(!("error" in made));
  const book = made as Book;
  const model = { json: async () => assert.fail("no model"), write: async () => assert.fail("no model"), contextChars: () => 32000 };
  for (let i = 0; i < 20; i++) {
    const step = nextStep(book);
    if (!step) {
      if (book.stage === "review") {
        book.stage = "writing";
        continue;
      }
      break;
    }
    await runStep(book, step, model as never, new AbortController().signal);
  }
  assert.equal(book.chapters.length, 3);
  assert.ok(book.chapters.every((c) => puzzleReady(c.puzzle)));
  assert.match(bookHtml(book, { trim: "8.5x11" }), /Answer key[\s\S]*class="sudoku small"/);
  assert.match(bookMarkdown(book), /------\+-------\+------/);
});
