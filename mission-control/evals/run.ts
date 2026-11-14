/**
 * Eval suite: sends fixed prompts through the harness (same queue, system
 * prompts and Ollama settings as Mission Control) and scores the answers.
 *
 *   npm run eval                                  # default models, all cases
 *   npm run eval -- --models qwen3:14b --only code-slugify,voice-math
 *   npm run eval -- --repeat 3                    # run each case 3 times
 *   npm run eval -- --rescore evals/results/X.json  # reapply current checks to saved answers
 *
 * Results: evals/results/<timestamp>.json and evals/results/history.csv
 */
import crypto from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { AgentStreamPayload } from "../src/schemas/agent";
import { CASES, EvalCase } from "./cases";
import { cleanOutput } from "./checks";

const { values: args } = parseArgs({
  options: {
    models: { type: "string", default: process.env.EVAL_MODELS || "qwen3:14b,llama3.1:8b,qwen2.5-coder:14b" },
    only: { type: "string" },
    repeat: { type: "string", default: "1" },
    harness: { type: "string", default: process.env.HARNESS_URL || "http://127.0.0.1:3010" },
    timeout: { type: "string", default: "240" },
    rescore: { type: "string" },
  },
});

const HARNESS = args.harness!.replace(/\/+$/, "");
const MODELS = args.models!.split(",").map((m) => m.trim()).filter(Boolean);
const REPEAT = Math.max(1, Number(args.repeat) || 1);
const TIMEOUT_MS = (Number(args.timeout) || 240) * 1000;
const RESULTS_DIR = path.join(__dirname, "results");
const authHeaders: Record<string, string> = process.env.HARNESS_TOKEN
  ? { Authorization: `Bearer ${process.env.HARNESS_TOKEN}` }
  : {};

interface RunResult {
  model: string;
  caseId: string;
  agent: string;
  run: number;
  pass: boolean;
  checksPassed: number;
  checksTotal: number;
  failures: string[];
  status: string;
  ttftMs: number | null;
  totalMs: number;
  output: string;
}

/** Runs one task through the harness and collects its streamed output. */
async function runTask(model: string, c: Pick<EvalCase, "agent" | "prompt" | "source">) {
  const taskId = crypto.randomUUID();
  const controller = new AbortController();
  // Subscribe before dispatching so no event is missed
  const stream = await fetch(`${HARNESS}/api/agent/stream?taskId=${taskId}`, { signal: controller.signal });
  if (!stream.ok || !stream.body) throw new Error(`stream HTTP ${stream.status}`);

  const started = Date.now();
  const res = await fetch(`${HARNESS}/api/agent/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ id: taskId, prompt: c.prompt, targetAgent: c.agent, source: c.source ?? "eval", model }),
  });
  if (!res.ok) throw new Error(`run HTTP ${res.status}: ${await res.text()}`);

  let output = "";
  let ttftMs: number | null = null;
  let status = "timeout";
  const timer = setTimeout(() => {
    void fetch(`${HARNESS}/api/agent/${taskId}/cancel`, { method: "POST", headers: authHeaders }).catch(() => {});
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!data) continue;
        const event = JSON.parse(data.slice(5)) as AgentStreamPayload;
        if (event.status === "streaming") {
          ttftMs ??= event.timestamp - started;
          output += event.logChunk;
        } else if (event.status === "complete" || event.status === "error" || event.status === "canceled") {
          status = event.status;
          if (event.status === "error") output += event.logChunk;
          break outer;
        }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { output, ttftMs, totalMs: Date.now() - started, status };
}

async function scoreCase(model: string, c: EvalCase, run: number): Promise<RunResult> {
  const { output, ttftMs, totalMs, status } = await runTask(model, c);
  return applyChecks(model, c, run, { output: cleanOutput(output), ttftMs, totalMs, status });
}

async function applyChecks(
  model: string,
  c: EvalCase,
  run: number,
  { output: cleaned, ttftMs, totalMs, status }: { output: string; ttftMs: number | null; totalMs: number; status: string },
): Promise<RunResult> {
  const failures: string[] = [];
  let passed = 0;
  if (status !== "complete") failures.push(`task ${status}`);
  else {
    for (const check of c.checks) {
      const r = await check.run(cleaned);
      if (r.pass) passed++;
      else failures.push(`${check.name}: ${r.skipped ? "skipped, " : ""}${r.detail ?? "failed"}`);
    }
  }
  return {
    model, caseId: c.id, agent: c.agent, run, status, ttftMs, totalMs, output: cleaned,
    pass: status === "complete" && passed === c.checks.length,
    checksPassed: passed, checksTotal: c.checks.length, failures,
  };
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const secs = (ms: number | null) => (ms === null ? "—" : (ms / 1000).toFixed(1) + "s");
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const csv = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** Reapplies the current checks to answers saved by an earlier run (no model calls). */
async function rescore(file: string) {
  const saved = JSON.parse(await readFile(file, "utf8")) as { models: string[]; ollama: string | null; results: RunResult[] };
  const results: RunResult[] = [];
  for (const old of saved.results) {
    const c = CASES.find((x) => x.id === old.caseId);
    if (!c) continue;
    const r = await applyChecks(old.model, c, old.run, old);
    if (r.pass !== old.pass) console.log(`  ${old.pass ? "PASS→FAIL" : "FAIL→PASS"} ${old.model} ${c.id} #${old.run}${r.failures.length ? ": " + r.failures.join("; ") : ""}`);
    results.push(r);
  }
  console.log("");
  printSummary(results, saved.models);
  await saveResults(results, saved.models, saved.ollama);
}

async function main() {
  if (args.rescore) return rescore(args.rescore);
  const selected = args.only ? CASES.filter((c) => args.only!.split(",").includes(c.id)) : CASES;
  if (selected.length === 0) throw new Error(`No cases match --only ${args.only}`);

  const health = await fetch(`${HARNESS}/health`).then((r) => r.json() as Promise<{ ollama: string | null }>);
  if (!health.ollama) throw new Error(`Harness at ${HARNESS} can't reach Ollama`);
  console.log(`Harness ${HARNESS}, Ollama ${health.ollama}`);
  console.log(`${selected.length} cases × ${MODELS.length} models × ${REPEAT} run(s)\n`);

  const results: RunResult[] = [];
  for (const model of MODELS) {
    console.log(`=== ${model} ===`);
    // Load the model first so the first case's timing isn't mostly load time
    const warm = await runTask(model, { agent: "planner", prompt: "Reply with OK." });
    if (warm.status !== "complete") {
      console.log(`  warm-up ${warm.status}: ${warm.output.trim().slice(0, 120)} — skipping model\n`);
      continue;
    }
    for (const c of selected) {
      for (let run = 1; run <= REPEAT; run++) {
        const r = await scoreCase(model, c, run);
        results.push(r);
        const mark = r.pass ? "PASS" : "FAIL";
        console.log(`  [${mark}] ${pad(c.id, 24)} ${pad(`${r.checksPassed}/${r.checksTotal}`, 5)} ttft ${pad(secs(r.ttftMs), 6)} total ${secs(r.totalMs)}`);
        for (const f of r.failures) console.log(`         - ${f}`);
      }
    }
    console.log("");
  }

  printSummary(results, MODELS);
  await saveResults(results, MODELS, health.ollama);
}

function printSummary(results: RunResult[], models: string[]) {
  console.log("Summary");
  console.log(`${pad("model", 22)}${pad("pass", 10)}${pad("checks", 10)}${pad("avg ttft", 10)}avg total`);
  for (const model of models) {
    const rs = results.filter((r) => r.model === model);
    if (!rs.length) continue;
    const passCount = rs.filter((r) => r.pass).length;
    const checks = rs.reduce((a, r) => a + r.checksPassed, 0);
    const total = rs.reduce((a, r) => a + r.checksTotal, 0);
    const ttfts = rs.map((r) => r.ttftMs).filter((t): t is number => t !== null);
    console.log(
      `${pad(model, 22)}${pad(`${passCount}/${rs.length}`, 10)}${pad(`${checks}/${total}`, 10)}${pad(secs(avg(ttfts)), 10)}${secs(avg(rs.map((r) => r.totalMs)))}`,
    );
  }
}

async function saveResults(results: RunResult[], models: string[], ollama: string | null) {
  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonFile = path.join(RESULTS_DIR, `${stamp}.json`);
  await writeFile(jsonFile, JSON.stringify({ harness: HARNESS, ollama, models, results }, null, 2));

  const historyFile = path.join(RESULTS_DIR, "history.csv");
  const header = "timestamp,model,case,agent,run,pass,checks_passed,checks_total,status,ttft_ms,total_ms,failures\n";
  const rows = results
    .map((r) => [stamp, r.model, r.caseId, r.agent, r.run, r.pass, r.checksPassed, r.checksTotal, r.status, r.ttftMs, r.totalMs, r.failures.join("; ")].map(csv).join(","))
    .join("\n");
  await appendFile(historyFile, (existsSync(historyFile) ? "" : header) + rows + "\n");
  console.log(`\nSaved ${path.relative(process.cwd(), jsonFile)} and ${path.relative(process.cwd(), historyFile)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
