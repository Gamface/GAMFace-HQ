import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface CheckResult {
  pass: boolean;
  skipped?: boolean;
  detail?: string;
}

export interface Check {
  name: string;
  run: (output: string) => CheckResult | Promise<CheckResult>;
}

const ok = (pass: boolean, detail?: string): CheckResult => ({ pass, detail: pass ? undefined : detail });

// Reasoning models may still emit <think> blocks in content
export function cleanOutput(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export function containsAll(...words: string[]): Check {
  return {
    name: `mentions ${words.join(" + ")}`,
    run: (out) => {
      const missing = words.filter((w) => !out.toLowerCase().includes(w.toLowerCase()));
      return ok(missing.length === 0, `missing: ${missing.join(", ")}`);
    },
  };
}

export function matches(re: RegExp, name = `matches ${re}`): Check {
  return { name, run: (out) => ok(re.test(out), `no match for ${re}`) };
}

export function notMatches(re: RegExp, name = `avoids ${re}`): Check {
  return { name, run: (out) => ok(!re.test(out), `unexpected match for ${re}`) };
}

export function minMatches(re: RegExp, count: number, name: string): Check {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return {
    name,
    run: (out) => {
      const n = out.match(global)?.length ?? 0;
      return ok(n >= count, `found ${n}, need ${count}`);
    },
  };
}

export function maxWords(limit: number): Check {
  return {
    name: `at most ${limit} words`,
    run: (out) => {
      const n = out.split(/\s+/).filter(Boolean).length;
      return ok(n <= limit, `${n} words`);
    },
  };
}

// For answers that get read aloud
export function noMarkdown(): Check {
  return {
    name: "no markdown",
    run: (out) => {
      if (/```|^\s*#{1,6}\s|\*\*/m.test(out)) return ok(false, "code fence, heading or bold");
      // A single line starting "12." is an answer, not a list; two list lines are a list
      const listLines = out.match(/^\s*([-*]|\d+\.)\s+\S/gm)?.length ?? 0;
      return ok(listLines < 2, `${listLines} list lines`);
    },
  };
}

export function exactly(expected: string): Check {
  return {
    name: `exactly "${expected}"`,
    run: (out) => {
      const got = out.trim().replace(/^["'`]+|["'`.!]+$/g, "");
      return ok(got === expected, `got "${out.trim().slice(0, 60)}"`);
    },
  };
}

export function jsonObject(name: string, test: (value: Record<string, unknown>) => boolean): Check {
  return {
    name,
    run: (out) => {
      try {
        const value = JSON.parse(out.trim());
        return ok(typeof value === "object" && value !== null && test(value), `JSON fields wrong: ${out.trim().slice(0, 80)}`);
      } catch {
        return ok(false, `not raw JSON: ${out.trim().slice(0, 80)}`);
      }
    },
  };
}

// --- Running generated code ---------------------------------------------------

export function extractCode(out: string): string | null {
  const blocks = [...out.matchAll(/```(?:ts|typescript|js|javascript)?[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length === 0) return null;
  // The longest block is almost always the implementation, not a usage snippet.
  // Drop top-level example calls: `console.log(parseDuration(""))` would throw
  // before our assertions run and fail a correct function.
  return blocks
    .sort((a, b) => b.length - a.length)[0]
    .split("\n")
    .filter((line) => !/^console\.\w+\(/.test(line))
    .join("\n");
}

let dockerAvailable: boolean | null = null;
async function hasDocker(): Promise<boolean> {
  if (dockerAvailable === null) {
    dockerAvailable = await exec("docker", ["version", "--format", "{{.Server.Version}}"]).then(
      () => true,
      () => false,
    );
  }
  return dockerAvailable;
}

export const SANDBOX_IMAGE = "node:22-bookworm-slim";

/**
 * Runs the model's code plus our assertions in a throwaway container:
 * no network, read-only filesystem, capped memory, CPU, processes and time.
 */
export function runsTypeScript(name: string, assertions: string): Check {
  return {
    name,
    run: async (out) => {
      const code = extractCode(out);
      if (!code) return { pass: false, detail: "no code block in answer" };
      if (!(await hasDocker())) return { pass: false, skipped: true, detail: "docker not available" };

      const dir = await mkdtemp(path.join(tmpdir(), "eval-"));
      try {
        const program = `${code}\n\n// --- eval assertions ---\nimport assert from "node:assert/strict";\n${assertions}\nconsole.log("EVAL_PASS");\n`;
        await writeFile(path.join(dir, "test.mts"), program);
        const { stdout } = await exec(
          "docker",
          [
            "run", "--rm", "--network", "none", "--read-only",
            "--memory", "256m", "--cpus", "1", "--pids-limit", "64",
            "-v", `${dir}:/w:ro`, SANDBOX_IMAGE,
            "timeout", "10", "node", "--experimental-strip-types", "--no-warnings", "/w/test.mts",
          ],
          { timeout: 60000 },
        );
        return ok(stdout.includes("EVAL_PASS"), "assertions did not finish");
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        // Node prints the throwing source line first; the actual error is the "XxxError: ..." line
        const text = e.stderr || e.message || String(err);
        const msg = text.match(/^\s*(\w*Error\b.*)$/m)?.[1] ?? text.split("\n").find((l) => l.trim()) ?? e.message;
        return { pass: false, detail: msg?.trim().slice(0, 160) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
