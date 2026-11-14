/**
 * Preflight: checks the whole chain end to end and prints a latency budget.
 *
 *   npm run preflight                                  # from WSL (harness on :3010)
 *   docker compose exec harness npm run preflight      # from inside the container
 *
 * Checks Ollama, the installed models, GPU offload, generation speed and prompt
 * caching, the routing model, a real task through the harness queue, a memory
 * write, and (if configured) a voice round trip: text → speech → text.
 *
 * Env (all optional): OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_FAST_MODEL,
 * HARNESS_URL, HARNESS_TOKEN, VOICE_TTS_URL, VOICE_TTS_MODEL, VOICE_TTS_VOICE,
 * VOICE_STT_URL, VOICE_STT_MODEL. Voice URLs are OpenAI-compatible bases, e.g.
 * http://127.0.0.1:8880/v1 (Kokoro-FastAPI) and http://127.0.0.1:8000/v1 (speaches).
 * Exits 1 if any check fails.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { makeJsonChat } from "../src/hq/ollama";
import { TEAM, routeTask, teamContext } from "../src/hq/team";

const OLLAMA = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11435").replace(/\/+$/, "");
const MODEL = process.env.OLLAMA_MODEL || "qwen3:14b";
const FAST_MODEL = process.env.OLLAMA_FAST_MODEL || MODEL;
const HARNESS = (process.env.HARNESS_URL || `http://127.0.0.1:${process.env.PORT || 3008}`).replace(/\/+$/, "");
const TOKEN = process.env.HARNESS_TOKEN || "";
const TTS_URL = (process.env.VOICE_TTS_URL || "").replace(/\/+$/, "");
const STT_URL = (process.env.VOICE_STT_URL || "").replace(/\/+$/, "");
const auth: Record<string, string> = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

type Level = "PASS" | "WARN" | "FAIL" | "SKIP";
const results: { level: Level; name: string; detail: string }[] = [];
const budget: { hear?: number; think?: number; firstToken?: number; tps?: number; speak?: number; queue?: number } = {};
const color: Record<Level, string> = { PASS: "\x1b[32m", WARN: "\x1b[33m", FAIL: "\x1b[31m", SKIP: "\x1b[90m" };

function report(level: Level, name: string, detail = "") {
  results.push({ level, name, detail });
  console.log(`${color[level]}${level.padEnd(4)}\x1b[0m  ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
}

const ms = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const sec = (n?: number) => (n === undefined ? "—" : `${(n / 1000).toFixed(1)}s`);

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    report("FAIL", name, error instanceof Error ? error.message : String(error));
  }
}

async function getJson<T>(url: string, init?: RequestInit, timeout = 5000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
}

let thinkingCapable = false;

interface ChatStats {
  firstTokenMs: number;
  totalMs: number;
  text: string;
  promptTokens: number;
  evalCount: number;
  evalNs: number;
  loadNs: number;
}

/** One streamed chat call with timings from Ollama's final stats frame. */
async function timedChat(system: string, user: string): Promise<ChatStats> {
  const start = Date.now();
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: true,
    keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
    options: { num_ctx: Number(process.env.OLLAMA_NUM_CTX) || 8192, num_predict: 64 },
  };
  if (thinkingCapable) body.think = false;
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let firstTokenMs = 0;
  let final: Record<string, number> = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string } & Record<string, number>;
      if (frame.error) throw new Error(String(frame.error));
      const piece = frame.message?.content ?? "";
      if (piece && !firstTokenMs) firstTokenMs = Date.now() - start;
      text += piece;
      if (frame.done) final = frame;
    }
  }
  return {
    firstTokenMs,
    totalMs: Date.now() - start,
    text,
    promptTokens: final.prompt_eval_count ?? 0,
    evalCount: final.eval_count ?? 0,
    evalNs: final.eval_duration ?? 0,
    loadNs: final.load_duration ?? 0,
  };
}

async function main() {
  console.log(`\nMission Control preflight\n  Ollama  ${OLLAMA}\n  Model   ${MODEL}  (fast: ${FAST_MODEL})\n  Harness ${HARNESS}\n`);

  // 1. Ollama
  let ollamaUp = false;
  await check("Ollama reachable", async () => {
    const t = Date.now();
    const v = await getJson<{ version: string }>(`${OLLAMA}/api/version`);
    ollamaUp = true;
    report("PASS", "Ollama reachable", `v${v.version}, ${ms(Date.now() - t)}`);
  });

  if (ollamaUp) {
    // 2. Models installed
    await check("Models installed", async () => {
      const tags = await getJson<{ models: { name: string }[] }>(`${OLLAMA}/api/tags`);
      const names = new Set(tags.models.flatMap((m) => [m.name, m.name.replace(/:latest$/, "")]));
      for (const m of new Set([MODEL, FAST_MODEL])) {
        if (names.has(m)) report("PASS", `Model ${m} installed`);
        else report("FAIL", `Model ${m} installed`, `run: ollama pull ${m}`);
      }
      try {
        const show = await getJson<{ capabilities?: string[] }>(`${OLLAMA}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL }),
        });
        thinkingCapable = Boolean(show.capabilities?.includes("thinking"));
      } catch {
        // leave false
      }
    });

    // 3. Generation speed + prompt caching (same stable system prompt twice)
    await check("Generation", async () => {
      const system = TEAM.planner.prompt + teamContext("planner");
      const cold = await timedChat(system, "Reply with exactly one word: ready");
      const warm = await timedChat(system, "Reply with exactly one word: online");
      const tps = warm.evalNs ? warm.evalCount / (warm.evalNs / 1e9) : 0;
      budget.think = warm.totalMs;
      budget.firstToken = warm.firstTokenMs;
      budget.tps = tps;
      if (cold.loadNs > 2e9) report("PASS", "Model loaded", `cold load ${ms(cold.loadNs / 1e6)} (first call only)`);
      if (!warm.text.trim()) {
        report("FAIL", "Model answers", "empty reply: if this is a reasoning model, keep OLLAMA_THINK=false");
      } else {
        report(tps >= 15 ? "PASS" : "WARN", "Generation speed", `${tps.toFixed(1)} tok/s, first token ${ms(warm.firstTokenMs)}${tps < 15 ? " (slow: model may not fit in VRAM)" : ""}`);
      }
      if (cold.promptTokens && warm.promptTokens && warm.promptTokens < cold.promptTokens * 0.5) {
        report("PASS", "Prompt cache reused", `${cold.promptTokens} → ${warm.promptTokens} prompt tokens processed`);
      } else if (cold.promptTokens) {
        report("WARN", "Prompt cache reused", `processed ${cold.promptTokens} then ${warm.promptTokens} prompt tokens; cache not reused`);
      }
    });

    // 4. GPU offload
    await check("GPU offload", async () => {
      const ps = await getJson<{ models?: { name: string; size: number; size_vram: number }[] }>(`${OLLAMA}/api/ps`);
      const m = (ps.models ?? []).find((x) => x.name === MODEL || x.name.replace(/:latest$/, "") === MODEL);
      if (!m) return report("WARN", "GPU offload", "model not loaded");
      const pct = m.size ? Math.round((100 * m.size_vram) / m.size) : 0;
      const gb = (m.size / 1024 ** 3).toFixed(1);
      report(pct >= 100 ? "PASS" : "WARN", "GPU offload", `${pct}% of ${gb} GB in VRAM${pct < 100 ? " (part runs on CPU: lower OLLAMA_NUM_CTX or use a smaller model)" : ""}`);
    });

    // 5. Routing model
    await check("Auto-routing", async () => {
      const chat = makeJsonChat(OLLAMA, "30m", 60000, async () => thinkingCapable && FAST_MODEL === MODEL);
      const t = Date.now();
      const r = await routeTask(chat, FAST_MODEL, "Fix the bug in this Python function");
      const took = Date.now() - t;
      if (r.reason === "keyword match") report("WARN", "Auto-routing", `model gave no usable answer, used keyword fallback (${ms(took)})`);
      else report(took < 4000 ? "PASS" : "WARN", "Auto-routing", `→ ${r.agent} in ${ms(took)}${took >= 4000 ? " (slow: set OLLAMA_FAST_MODEL=qwen3:4b)" : ""}`);
    });
  }

  // 6. Harness end to end
  let harnessUp = false;
  await check("Harness reachable", async () => {
    const h = await getJson<{ status: string; ollama: string | null }>(`${HARNESS}/health`);
    harnessUp = true;
    report(h.ollama ? "PASS" : "FAIL", "Harness reachable", h.ollama ? `harness sees Ollama v${h.ollama}` : "harness is up but cannot reach Ollama");
  });

  if (harnessUp) {
    await check("Task through queue", async () => {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180000);
      const start = Date.now();
      let firstOutput = 0;
      let finalStatus = "";
      // Subscribe first so no event is missed
      const stream = await fetch(`${HARNESS}/api/agent/stream?taskId=${id}`, { signal: controller.signal });
      const run = await fetch(`${HARNESS}/api/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ id, prompt: "Reply with exactly one word: ready", targetAgent: "coder", source: "eval" }),
      });
      if (!run.ok) throw new Error(`dispatch failed: HTTP ${run.status} ${await run.text()}`);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!data) continue;
            const e = JSON.parse(data.slice(6)) as { status: string };
            if (e.status === "streaming" && !firstOutput) firstOutput = Date.now() - start;
            if (["complete", "error", "canceled"].includes(e.status)) {
              finalStatus = e.status;
              break outer;
            }
          }
        }
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      const total = Date.now() - start;
      budget.queue = firstOutput;
      if (finalStatus === "complete") report("PASS", "Task through queue", `first output ${ms(firstOutput)}, done in ${ms(total)}`);
      else report("FAIL", "Task through queue", finalStatus ? `ended as ${finalStatus}` : "timed out");
    });

    await check("Agent models", async () => {
      const m = await getJson<{ resolved: Record<string, string>; providers: { id: string; local: boolean }[] }>(`${HARNESS}/api/models`);
      const checks = await getJson<{ id: string; ok: boolean; detail: string }[]>(`${HARNESS}/api/models/check`, undefined, 20000);
      let installed = new Set<string>();
      try {
        const tags = await getJson<{ models: { name: string }[] }>(`${OLLAMA}/api/tags`);
        installed = new Set(tags.models.flatMap((t) => [t.name, t.name.replace(/:latest$/, "")]));
      } catch {
        // reported by the Ollama check above
      }
      const ollamaModels = new Set<string>();
      for (const [role, ref] of Object.entries(m.resolved)) {
        const slash = ref.indexOf("/");
        const provider = ref.slice(0, slash);
        const model = ref.slice(slash + 1);
        if (provider === "ollama") {
          ollamaModels.add(model);
          if (!installed.has(model)) report("FAIL", `${role} model`, `${ref} is not installed: ollama pull ${model}`);
        } else {
          const c = checks.find((x) => x.id === provider);
          report(c?.ok ? "PASS" : "FAIL", `${role} model`, `${ref}${c ? ` (${c.detail})` : " (provider missing)"}`);
        }
      }
      const missing = [...ollamaModels].filter((x) => !installed.has(x));
      if (!missing.length) report("PASS", "Agent models", `local models ready: ${[...ollamaModels].join(", ")}`);
      if (ollamaModels.size > 2) {
        report("WARN", "Model swapping", `${ollamaModels.size} different local models: each swap reloads the GPU. Set OLLAMA_MAX_LOADED_MODELS=2 on Windows and keep sizes small.`);
      }
    });

    await check("Memory write", async () => {
      const text = `Preflight check ${new Date().toISOString()}`;
      const created = await getJson<{ id: number }>(`${HARNESS}/api/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ text, pinned: false }),
      });
      const list = await getJson<{ id: number; text: string }[]>(`${HARNESS}/api/memories`);
      const found = list.some((m) => m.id === created.id && m.text === text);
      await fetch(`${HARNESS}/api/memories/${created.id}/delete`, { method: "POST", headers: auth });
      report(found ? "PASS" : "FAIL", "Memory write", found ? "saved, read back and removed" : "saved but not found on read-back");
    });
  }

  // 7. Voice round trip: speak a phrase, transcribe it, compare
  if (!TTS_URL || !STT_URL) {
    report("SKIP", "Voice round trip", "set VOICE_TTS_URL and VOICE_STT_URL to test speech");
  } else {
    await check("Voice round trip", async () => {
      const phrase = "Preflight check complete. All systems are ready.";
      let t = Date.now();
      const tts = await fetch(`${TTS_URL}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: process.env.VOICE_TTS_MODEL || "kokoro", voice: process.env.VOICE_TTS_VOICE || "bm_george", input: phrase, response_format: "wav" }),
        signal: AbortSignal.timeout(60000),
      });
      if (!tts.ok) throw new Error(`TTS HTTP ${tts.status}`);
      const audio = await tts.arrayBuffer();
      budget.speak = Date.now() - t;

      t = Date.now();
      const form = new FormData();
      form.append("file", new Blob([audio], { type: "audio/wav" }), "preflight.wav");
      form.append("model", process.env.VOICE_STT_MODEL || "Systran/faster-whisper-small");
      const stt = await fetch(`${STT_URL}/audio/transcriptions`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
      if (!stt.ok) throw new Error(`STT HTTP ${stt.status}`);
      const heard = ((await stt.json()) as { text?: string }).text ?? "";
      budget.hear = Date.now() - t;

      const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];
      const said = new Set(words(phrase));
      const got = words(heard);
      const match = got.filter((w) => said.has(w)).length / said.size;
      report(match >= 0.6 ? "PASS" : "WARN", "Voice round trip", `heard "${heard.trim()}" (${Math.round(match * 100)}% match), speak ${ms(budget.speak)}, hear ${ms(budget.hear)}`);
    });
  }

  // Summary
  const fails = results.filter((r) => r.level === "FAIL").length;
  const warns = results.filter((r) => r.level === "WARN").length;
  const loop = (budget.hear ?? 0) + (budget.think ?? 0) + (budget.speak ?? 0);
  console.log(
    `\nLatency budget: hear ${sec(budget.hear)} · think ${sec(budget.think)}` +
      (budget.firstToken !== undefined ? ` (first token ${sec(budget.firstToken)}, ${budget.tps?.toFixed(0)} tok/s)` : "") +
      ` · speak ${sec(budget.speak)}` +
      (budget.hear !== undefined && budget.speak !== undefined ? `  =  ${sec(loop)} per spoken turn` : ""),
  );
  if (budget.queue !== undefined) console.log(`Harness queue: first output ${sec(budget.queue)} after dispatch`);
  console.log(`\n${fails ? "\x1b[31m" : warns ? "\x1b[33m" : "\x1b[32m"}${fails} failed, ${warns} warnings\x1b[0m\n`);
  process.exit(fails ? 1 : 0);
}

void main();
