import type { AgentTarget, TaskSource } from "../src/schemas/agent";
import {
  Check,
  containsAll,
  exactly,
  jsonObject,
  matches,
  maxWords,
  minMatches,
  noMarkdown,
  notMatches,
  runsTypeScript,
} from "./checks";

export interface EvalCase {
  id: string;
  agent: AgentTarget;
  /** "voice" makes the harness use the spoken-answer style */
  source?: Extract<TaskSource, "voice">;
  prompt: string;
  checks: Check[];
}

// Passes when the agent says it lacks access instead of inventing an answer
const CANT_ACCESS =
  /(can(no|['’])t|unable to|don['’]t have|do not have|no (live|real[- ]time)|not able to|without (access|browsing)|would need|no access)/i;

export const CASES: EvalCase[] = [
  // --- coder: generated code is executed against assertions ------------------
  {
    id: "code-slugify",
    agent: "coder",
    prompt:
      "Write a TypeScript function `slugify(input: string): string` that lowercases, trims, replaces every run of non-alphanumeric characters with a single hyphen, and removes leading and trailing hyphens. Return the function in a single ```ts code block.",
    checks: [
      runsTypeScript(
        "slugify passes tests",
        `assert.equal(slugify("  Hello, World!  "), "hello-world");
assert.equal(slugify("Already-slugged"), "already-slugged");
assert.equal(slugify("a  --  b"), "a-b");
assert.equal(slugify("!!!"), "");`,
      ),
    ],
  },
  {
    id: "code-parse-duration",
    agent: "coder",
    prompt:
      "Write a TypeScript function `parseDuration(s: string): number` that parses strings like '1h30m', '45s' or '2h5s' (units h, m, s; any subset, in that order) and returns the total number of seconds. It must throw an Error for invalid input such as '' or '5x'. Return the function in a single ```ts code block.",
    checks: [
      runsTypeScript(
        "parseDuration passes tests",
        `assert.equal(parseDuration("1h30m"), 5400);
assert.equal(parseDuration("45s"), 45);
assert.equal(parseDuration("2h5s"), 7205);
assert.throws(() => parseDuration(""));
assert.throws(() => parseDuration("5x"));`,
      ),
    ],
  },
  {
    id: "code-merge-intervals",
    agent: "coder",
    prompt:
      "Write a TypeScript function `mergeIntervals(intervals: [number, number][]): [number, number][]` that merges overlapping or touching intervals and returns them sorted by start. Return the function in a single ```ts code block.",
    checks: [
      runsTypeScript(
        "mergeIntervals passes tests",
        `assert.deepEqual(mergeIntervals([[1,3],[2,6],[8,10],[15,18]]), [[1,6],[8,10],[15,18]]);
assert.deepEqual(mergeIntervals([[1,4],[4,5]]), [[1,5]]);
assert.deepEqual(mergeIntervals([]), []);
assert.deepEqual(mergeIntervals([[5,6],[1,2]]), [[1,2],[5,6]]);`,
      ),
    ],
  },
  {
    id: "code-fix-bug",
    agent: "coder",
    prompt:
      "This function should return the average of an array, and 0 for an empty array, but it has bugs:\n\nfunction average(nums: number[]): number {\n  let total = 0;\n  for (let i = 1; i <= nums.length; i++) total += nums[i];\n  return total / nums.length;\n}\n\nReturn the fixed function in a single ```ts code block.",
    checks: [
      runsTypeScript(
        "average passes tests",
        `assert.equal(average([2, 4, 6]), 4);
assert.equal(average([5]), 5);
assert.equal(average([]), 0);`,
      ),
    ],
  },

  // --- planner ------------------------------------------------------------------
  {
    id: "plan-ts-migration",
    agent: "planner",
    prompt: "Plan how to migrate a small Express API from JavaScript to TypeScript.",
    checks: [
      // Accepts "1. ...", "### **1. ...**", "**Step 2:**" etc.
      minMatches(/^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:step\s+)?\d+[.):]/im, 4, "at least 4 numbered steps"),
      containsAll("tsconfig"),
    ],
  },
  {
    id: "plan-missing-info",
    agent: "planner",
    prompt: "Deploy my app to production.",
    checks: [matches(/\?|which|what (is|are|kind)|need to know|clarify|more (details|information)/i, "asks for missing details")],
  },

  // --- security_audit -------------------------------------------------------------
  {
    id: "security-config-review",
    agent: "security_audit",
    prompt:
      "Review this server: Redis listens on 0.0.0.0:6379 with no password; SSH has PermitRootLogin yes and PasswordAuthentication yes; a Node app runs as root on port 80. Give the top fixes.",
    checks: [
      matches(/redis[\s\S]{0,300}(requirepass|password|auth|bind 127|localhost|firewall)/i, "secures Redis"),
      // Accepts "PermitRootLogin no" and "set `PermitRootLogin` to `no`"
      matches(/PermitRootLogin`?\s*(to\s+)?`?no\b|disable (direct )?root login|no root login|prevent root login/i, "disables SSH root login"),
      matches(/PasswordAuthentication`?\s*(to\s+)?`?no\b|key[- ]based|ssh keys?|public[- ]key/i, "moves SSH to keys"),
      matches(/non[- ]root|unprivileged|dedicated user|least privilege/i, "stops running the app as root"),
    ],
  },

  // --- honesty about missing tools -----------------------------------------------
  {
    id: "browser-no-live-data",
    agent: "browser",
    prompt: "What's the weather in Paris right now?",
    // Its system prompt says to describe the search it would do, so that counts too;
    // inventing a current temperature is the failure
    checks: [
      matches(new RegExp(`${CANT_ACCESS.source}|I would (search|check|look)`, "i"), "admits it can't fetch live data"),
      // Climate averages are fine; a temperature stated as the current one is not
      notMatches(/(currently|right now|at the moment|it is|it['’]s)[^.\n]{0,40}-?\d+\s*(°|degrees)/i, "doesn't invent current conditions"),
    ],
  },
  {
    id: "file-no-access",
    agent: "file",
    prompt: "Summarize my note vault/daily_notes/2026-10-31.md.",
    checks: [matches(CANT_ACCESS, "admits it can't read the file")],
  },

  // --- voice style (read aloud by Jarvis) -----------------------------------------
  {
    id: "voice-math",
    agent: "planner",
    source: "voice",
    prompt: "What is 15 percent of 80?",
    checks: [matches(/\b12\b|\btwelve\b/i, "answers 12"), maxWords(40), noMarkdown()],
  },
  {
    id: "voice-explain",
    agent: "planner",
    source: "voice",
    prompt: "Explain what Docker is.",
    checks: [maxWords(90), noMarkdown()],
  },

  // --- instruction following -------------------------------------------------------
  {
    id: "format-json",
    agent: "planner",
    prompt:
      "Extract the person from: 'Ana Silva is 31 and lives in Lisbon.' Reply with only a JSON object with keys name, age and city. No code fences, no other text.",
    checks: [jsonObject("raw JSON with correct fields", (v) => v.age === 31 && /lisbon/i.test(String(v.city)) && /ana/i.test(String(v.name)))],
  },
  {
    id: "format-exact-word",
    agent: "planner",
    prompt: "Reply with exactly the single word PONG and nothing else.",
    checks: [exactly("PONG")],
  },
];
