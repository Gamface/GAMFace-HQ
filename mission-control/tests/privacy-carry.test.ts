import assert from "node:assert/strict";
import { test } from "node:test";
import { carriedPrivate, privateBlock, splitPrivate } from "../src/hq/privacy";

// What a lead saw: the instructions and tool list (public), the user's request (public),
// and the hive log, memories and vault notes (private).
const lead = [
  "You are Jarvis. YOUR TEAM: - tools: Jarvis Tools. Installed: espn: scores (Live scores), odds (Spread, total and moneyline lines); wikipedia: search, article",
  "[Context for reference: do not answer it]\n" +
    privateBlock(
      "HIVE MIND (recent team activity):\n- tools: espn.standings basketball nba\n- planner: Booked the dentist with Dr Patel on Harley Street, ref 48213. Call 555-0142 to move it.\n",
      "HIVE MIND (activity only)",
    ) +
    privateBlock("RELEVANT MEMORIES:\n- The user is allergic to peanuts and shellfish.\n- Works at Gamface on the Lumen project.\n", "RELEVANT MEMORIES: (withheld)") +
    "[End of context]\n\nREQUEST:\nWhat NBA games are on tonight, and what are the betting lines?",
];
const seen = splitPrivate(lead);
const check = (handoff: string) => carriedPrivate(handoff, seen.private, seen.public, seen.personal);

test("splitPrivate: private block contents vs what a cloud model sees", () => {
  assert.match(seen.private, /Dr Patel/);
  assert.match(seen.private, /allergic to peanuts/);
  assert.doesNotMatch(seen.public, /Patel|peanuts|48213/);
  assert.match(seen.public, /betting lines/);
  // A block cut off by truncation is private from its start
  const cut = splitPrivate([`ok ${privateBlock("secret plan", "").slice(0, 10)} tail`]);
  assert.match(cut.private, /secr/);
});

test("ordinary lookups carry nothing private", () => {
  assert.deepEqual(check("Use espn.scores and espn.odds to get tonight's NBA games and betting lines."), []);
  assert.deepEqual(check("Search Wikipedia for the Eiffel Tower and read the article."), []);
  // Words the user said themselves are public, even if the hive log has them too
  assert.deepEqual(check("Get the NBA betting lines for tonight"), []);
  // Years and sentence-starting capitals aren't treated as private
  assert.deepEqual(check("Booked results for 2026 please."), []);
  // Wording copied from the lead's own earlier handoff in the hive log, all of it public words
  const withOldHandoff = splitPrivate([
    lead[0],
    privateBlock("HIVE MIND:\n- planner: delegated → tools: Use the espn.scores method to get the current NBA scores\n", ""),
    "REQUEST:\nGet tonight's NBA scores",
  ]);
  assert.deepEqual(carriedPrivate("Use the espn.scores method to get the current NBA scores.", withOldHandoff.private, withOldHandoff.public, withOldHandoff.personal), []);
  // Phrases are compared with memories and notes only: the agents' own wording in the hive log doesn't count
  const hiveWording = splitPrivate([
    lead[0],
    privateBlock("HIVE MIND:\n- tools: After obtaining the data identify the three closest spreads\n", ""),
    "REQUEST:\nNBA odds",
  ]);
  assert.match(hiveWording.private, /obtaining/);
  assert.doesNotMatch(hiveWording.personal, /obtaining/);
  assert.deepEqual(carriedPrivate("After obtaining the data identify the three closest spreads.", hiveWording.private, hiveWording.public, hiveWording.personal), []);
});

test("names, numbers and identifiers from private material are caught", () => {
  const names = check("Find the opening hours of Dr Patel's practice on Harley Street");
  for (const w of ["Patel's", "Harley"]) assert.ok(names.includes(w), `${w} in ${names.join(", ")}`);
  assert.ok(check("Look up booking ref 48213").includes("48213"));
  assert.ok(check("Call 555-0142 and ask").includes("555-0142"));
  assert.ok(check("Search news about Gamface and the Lumen project").includes("Gamface"));
});

test("a phrase copied from private material is caught", () => {
  const found = check("Find recipes; note the user is allergic to peanuts and shellfish");
  assert.ok(found.some((f) => f.includes("allergic to peanuts")), found.join(", "));
});

test("a paraphrase in plain words isn't caught (the setting covers this)", () => {
  assert.deepEqual(check("Find recipes without nuts for someone with a peanut allergy"), []);
});
