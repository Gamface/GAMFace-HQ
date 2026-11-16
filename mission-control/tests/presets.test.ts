// Model presets: saved team setups, applied in one go or per project.   npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { ModelRegistry, parsePresetCommand } from "../src/hq/models";
import { projectScope } from "../src/hq/projects";
import { TaskStore } from "../src/hq/taskstore";

function setup() {
  process.env.FAKE_CLOUD_KEY = "k";
  const store = new TaskStore(":memory:");
  const models = new ModelRegistry(store, { model: "qwen3:14b", fastModel: "qwen3:4b", numCtx: 8192, think: false });
  assert.equal(models.update({ customProviders: [{ id: "cloudy", name: "Fake cloud", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "FAKE_CLOUD_KEY" }] }), null);
  return models;
}

test("built-in presets: all local and fast", () => {
  const models = setup();
  const ids = models.presets().map((p) => p.id);
  assert.deepEqual(ids, ["local", "fast"]);
  const fast = models.preset("fast")!;
  assert.equal(fast.models.coder!.model, "ollama/qwen3:4b");
  assert.equal(fast.models.vision!.model, models.preset("local")!.models.vision!.model, "vision keeps a model that can see");
  assert.equal(models.activePreset()?.id, "local", "a fresh team matches All local");
});

test("save the current setup, apply presets, and skip local-only agents", () => {
  const models = setup();
  assert.equal(models.update({ roles: { planner: { model: "cloudy/big", fallback: "ollama/qwen3:14b" }, coder: { model: "cloudy/coder" } } as never }), null);
  const best = models.savePreset("Best quality");
  assert.ok(!("error" in best));
  if ("error" in best) return;
  assert.equal(best.id, "best-quality");
  assert.equal(best.models.planner!.fallback, "ollama/qwen3:14b");
  assert.equal(models.activePreset()?.id, "best-quality");
  assert.match((models.savePreset("best QUALITY") as { error: string }).error, /already a preset/);
  assert.match((models.savePreset("x", { planner: { model: 42 } }) as { error: string }).error, /missing model/);
  assert.match((models.savePreset("x", { pilot: { model: "ollama/qwen3:14b" } }) as { error: string }).error, /Unknown agent/);
  assert.match((models.savePreset("Fast!", undefined, "fast") as { error: string }).error, /Built-in/);

  // Back to local: every agent switches, fallbacks cleared
  const local = models.applyPreset("local");
  assert.ok(!("error" in local));
  assert.equal(models.settings().roles.planner.model, "ollama/qwen3:14b");
  assert.equal(models.settings().roles.planner.fallback, undefined);
  assert.equal(models.activePreset()?.id, "local");

  // A preset that gives the File agent (local only) a cloud model leaves it alone
  const mixed = models.savePreset("Cloud everything", { planner: { model: "cloudy/big" }, file: { model: "cloudy/big" } });
  if ("error" in mixed) throw new Error(mixed.error);
  const out = models.applyPreset(mixed.id);
  assert.ok(!("error" in out));
  if ("error" in out) return;
  assert.deepEqual(out.applied, ["planner"]);
  assert.deepEqual(out.skipped, [{ role: "file", reason: "local only" }]);
  assert.equal(models.settings().roles.file.model, "ollama/qwen3:14b");
  assert.equal(models.settings().roles.planner.model, "cloudy/big");

  // Rename and delete
  const renamed = models.savePreset("Cloud brains", undefined, mixed.id);
  assert.ok(!("error" in renamed) && renamed.name === "Cloud brains" && renamed.id === mixed.id);
  assert.ok(models.removePreset(mixed.id));
  assert.equal(models.removePreset("local"), false);
});

test("a project's preset decides its cards' models without changing the team", () => {
  const models = setup();
  const best = models.savePreset("Best", { planner: { model: "cloudy/big", fallback: "ollama/qwen3:14b" } });
  if ("error" in best) throw new Error(best.error);
  assert.equal(models.resolve("planner").ref, "ollama/qwen3:14b");
  const inProject = projectScope.run({ id: "g-aaaa", name: "G", localOnly: false, preset: best.id }, () => ({
    planner: models.resolve("planner").ref,
    coder: models.resolve("coder").ref,
    fallback: models.resolveFallback("planner")?.ref,
  }));
  assert.deepEqual(inProject, { planner: "cloudy/big", coder: "ollama/qwen3:14b", fallback: "ollama/qwen3:14b" });
  const fast = projectScope.run({ id: "s-bbbb", name: "S", localOnly: false, preset: "fast" }, () => models.resolve("coder").ref);
  assert.equal(fast, "ollama/qwen3:4b");
  // Outside the project, nothing changed
  assert.equal(models.resolve("planner").ref, "ollama/qwen3:14b");
});

test("preset commands", () => {
  assert.equal(parsePresetCommand("use preset fast"), "fast");
  assert.equal(parsePresetCommand("Switch to the local preset."), "local");
  assert.equal(parsePresetCommand("preset Best Quality"), "best quality");
  assert.equal(parsePresetCommand('apply preset "cloud brains"'), "cloud brains");
  assert.equal(parsePresetCommand("go best preset"), "best");
  assert.equal(parsePresetCommand("write a preset for my synth patch library please"), null);
  assert.equal(parsePresetCommand("switch coder to claude"), null);
});

test("no Fast preset when the fast model is the main model", () => {
  const store = new TaskStore(":memory:");
  const models = new ModelRegistry(store, { model: "qwen3:14b", fastModel: "qwen3:14b", numCtx: 8192, think: false });
  assert.deepEqual(models.presets().map((p) => p.id), ["local"]);
});
