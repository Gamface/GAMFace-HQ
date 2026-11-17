// Projects: separate instructions, memories, activity, skills, assets, brand and sign-ins.   npm test
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Assets } from "../src/hq/assets";
import { ModelGateway } from "../src/hq/gateway";
import { Hive } from "../src/hq/hive";
import { Memory } from "../src/hq/memory";
import { ModelRegistry } from "../src/hq/models";
import { Notices } from "../src/hq/notices";
import { resolvePrivate } from "../src/hq/privacy";
import { Projects, projectPrompt, projectScope, visibleIn } from "../src/hq/projects";
import { Skills } from "../src/hq/skills";
import { TaskStore } from "../src/hq/taskstore";
import { AgentTaskSchema, TaskPatchSchema } from "../src/schemas/agent";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "projects-"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082", "hex").toString("base64");

test("projects are created, renamed, archived and deleted, with unique names and profiles", () => {
  const dir = tmp();
  const projects = new Projects(dir);
  const g = projects.create({ name: "Gamface", instructions: "Playful voice.", profiles: ["gamface-x"] });
  assert.ok(!("error" in g));
  if ("error" in g) return;
  assert.match(g.id, /^gamface-[a-f0-9]{4}$/);
  assert.equal(g.color, "#22d3ee");
  assert.match((projects.create({ name: "gamface" }) as { error: string }).error, /already a project/);
  assert.match((projects.create({ name: "General" }) as { error: string }).error, /General/);
  assert.match((projects.create({ name: "Side" , profiles: ["gamface-x"] }) as { error: string }).error, /already belongs to the project “Gamface”/);
  const side = projects.create({ name: "Side gig", localOnly: true });
  if ("error" in side) throw new Error(side.error);
  assert.equal(projects.ownerOfProfile("gamface-x")?.id, g.id);
  assert.equal(projects.ownerOfProfile("main"), undefined);
  assert.deepEqual(projects.scope(side.id), { id: side.id, name: "Side gig", localOnly: true });
  assert.deepEqual(projects.scope(null), { id: null, name: "General", localOnly: false });
  assert.deepEqual(projects.scope("nope-0000"), { id: null, name: "General", localOnly: false });
  assert.match((projects.update(side.id, { name: "Gamface" }) as { error: string }).error, /already/);
  const renamed = projects.update(side.id, { name: "Freelance", archived: true });
  assert.ok(!("error" in renamed) && renamed.archived);
  assert.deepEqual(projects.list(false).map((p) => p.name), ["Gamface"]);
  projects.dropProfile("gamface-x");
  assert.equal(projects.ownerOfProfile("gamface-x"), undefined);
  // Survives a restart
  const again = new Projects(dir);
  assert.equal(again.list().length, 2);
  assert.equal(again.name(g.id), "Gamface");
  assert.equal(again.name(null), "General");
  assert.ok(again.remove(side.id));
  assert.equal(again.list().length, 1);
  assert.equal(visibleIn(undefined, g.id), true);
  assert.equal(visibleIn(g.id, g.id), true);
  assert.equal(visibleIn(g.id, null), false);
  assert.equal(visibleIn("other-1234", g.id), false);
});

test("cards and routines carry a project id; bad ids are refused", () => {
  assert.equal(AgentTaskSchema.parse({ prompt: "x", project: "gamface-ab12" }).project, "gamface-ab12");
  assert.equal(AgentTaskSchema.parse({ prompt: "x" }).project, undefined);
  assert.equal(AgentTaskSchema.safeParse({ prompt: "x", project: "../etc" }).success, false);
  assert.equal(TaskPatchSchema.parse({ project: null }).project, null);
});

test("the project's instructions and vault note go in the prompt", () => {
  const vault = tmp();
  mkdirSync(path.join(vault, "HQ", "projects"), { recursive: true });
  writeFileSync(path.join(vault, "HQ", "projects", "Gamface.md"), "Launch is on Dec 1.");
  const projects = new Projects(tmp());
  const g = projects.create({ name: "Gamface", instructions: "Write in a playful voice." });
  if ("error" in g) throw new Error(g.error);
  const text = projectPrompt(g, vault);
  assert.match(text, /project “Gamface”/);
  assert.match(text, /playful voice/);
  // The vault note is private: kept for local models, withheld from cloud ones
  assert.match(resolvePrivate(text, true).text, /Launch is on Dec 1/);
  assert.doesNotMatch(resolvePrivate(text, false).text, /Launch is on Dec 1/);
  assert.equal(projectPrompt(undefined, vault), "");
});

test("memories: a project sees its own and General ones; nothing leaks between projects", async () => {
  const mem = new Memory(":memory:", async () => ({}), "m");
  await mem.add("The user lives in New York and likes espresso", "shared", 0.6);
  await mem.add("Gamface launches with three game modes and espresso branding", "shared", 0.6, false, true, "gamface-aaaa");
  await mem.add("The side gig client wants espresso invoices monthly", "shared", 0.6, false, true, "side-bbbb");
  const inGamface = await mem.recall("espresso", "planner", 6, "gamface-aaaa");
  assert.equal(inGamface.length, 2);
  assert.ok(inGamface.some((t) => t.includes("New York")));
  assert.ok(!inGamface.some((t) => t.includes("side gig")));
  const inGeneral = await mem.recall("espresso", "planner", 6, null);
  assert.deepEqual(inGeneral, ["The user lives in New York and likes espresso"]);
  // The same fact in two projects isn't merged across them
  await mem.add("Gamface launches with three game modes and espresso branding", "shared", 0.6, false, true, "side-bbbb");
  assert.equal((await mem.list()).length, 4);
  await mem.maintain();
  assert.equal((await mem.list()).length, 4);
  assert.equal(await mem.removeProject("side-bbbb"), 2);
  assert.equal((await mem.list()).length, 2);
  // Moving a memory to General and back
  const fact = (await mem.list()).find((m) => m.project === "gamface-aaaa")!;
  assert.equal(await mem.setProject(fact.id, null), true);
  assert.equal((await mem.list()).find((m) => m.id === fact.id)!.project, undefined);
  await mem.setProject(fact.id, "gamface-aaaa");
  assert.equal((await mem.list()).find((m) => m.id === fact.id)!.project, "gamface-aaaa");
});

test("memory extraction keeps project facts in the project (all of them, privately, for a project kept on this PC)", async () => {
  let system = "";
  const reply = {
    memories: [
      { text: "Gamface's mascot is a fox named Pixel", importance: 0.7, shared: true, project: true },
      { text: "The user prefers short answers in general", importance: 0.6, shared: true, project: false },
      { text: "The user wants weekly reports on Fridays", importance: 0.5, shared: true },
    ],
  };
  const mem = new Memory(":memory:", async (_m, msgs) => ((system = String(msgs[0].content)), reply), "m");
  await mem.extract("planner", "q", "a", false, { id: "gamface-aaaa", name: "Gamface", keepAll: false });
  assert.match(system, /project "Gamface"/);
  const where = Object.fromEntries((await mem.list()).map((m) => [m.text.slice(0, 20), m.project ?? null]));
  assert.equal(where["Gamface's mascot is "], "gamface-aaaa");
  assert.equal(where["The user prefers sho"], null);
  // Unsure → the project's
  assert.equal(where["The user wants weekl"], "gamface-aaaa");
  // Nothing private went in, so these may be shared with cloud models
  assert.ok((await mem.list()).every((m) => m.private === false));
  const local = new Memory(":memory:", async () => reply, "m");
  await local.extract("planner", "q", "a", false, { id: "side-bbbb", name: "Side", keepAll: true });
  const kept = await local.list();
  assert.ok(kept.every((m) => m.project === "side-bbbb"));
  assert.ok(kept.every((m) => m.private), "a local-only project's memories never go to the cloud");
});

test("the activity log shows a project only its own cards and team-wide events", () => {
  const hive = new Hive(":memory:");
  const owner: Record<string, string | null> = { t1: "gamface-aaaa", t2: "side-bbbb", t3: null };
  hive.projectOf = (id) => owner[id];
  hive.log("coder", "done", "Gamface trailer", "t1");
  hive.log("browser", "done", "Side gig invoice", "t2");
  hive.log("planner", "done", "General errand", "t3");
  hive.log("models", "switched", "coder → claude");
  hive.log("planner", "done", "an old card no longer loaded", "gone");
  const g = hive.promptText(15, "gamface-aaaa");
  assert.match(g, /Gamface trailer/);
  assert.match(g, /coder → claude/);
  assert.doesNotMatch(g, /Side gig|General errand/);
  const gen = hive.promptText(15, null);
  assert.match(gen, /General errand/);
  assert.doesNotMatch(gen, /Gamface trailer|Side gig/);
  assert.equal(hive.recent(10).length, 5);
});

test("skills: a project uses its own and General skills, never another project's", () => {
  const store = new TaskStore(":memory:");
  const skills = new Skills(store.sql);
  const base = { description: "Write a weekly newsletter recap with highlights", steps: "1. Gather highlights\n2. Write the recap", agents: [] };
  const general = skills.create({ name: "Newsletter recap", ...base }, { status: "active" });
  const own = skills.create({ name: "Gamface newsletter recap", ...base, project: "gamface-aaaa" }, { status: "active" });
  const other = skills.create({ name: "Side newsletter recap", ...base }, { status: "active", project: "side-bbbb" });
  for (const s of [general, own, other]) assert.ok(!("error" in s));
  const ids = (p: string | null) => skills.match("write the weekly newsletter recap highlights", "planner", 5, p).map((s) => s.name).sort();
  assert.deepEqual(ids("gamface-aaaa"), ["Gamface newsletter recap", "Newsletter recap"]);
  assert.deepEqual(ids(null), ["Newsletter recap"]);
  // Moving a skill to General
  if ("error" in other) return;
  const moved = skills.update(other.id, { project: null });
  assert.ok(!("error" in moved) && !moved.project);
  assert.equal(ids(null).length, 2);
});

test("assets and brand: a project picks its own and General assets, and can have its own brand", () => {
  const assets = new Assets(tmp());
  const shared = assets.add({ name: "Beach", description: "summer waves", data: PNG });
  const mine = assets.add({ name: "Arena", description: "summer esports arena", data: PNG, project: "gamface-aaaa" });
  const theirs = assets.add({ name: "Office", description: "summer office", data: PNG, project: "side-bbbb" });
  for (const a of [shared, mine, theirs]) assert.ok(!("error" in a));
  if ("error" in shared || "error" in mine || "error" in theirs) return;
  const names = (p: string | null) => assets.pick("a summer promo", 6, p).map((a) => a.name).sort();
  assert.deepEqual(names("gamface-aaaa"), ["Arena", "Beach"]);
  assert.deepEqual(names(null), ["Beach"]);
  assert.equal(assets.countIn("gamface-aaaa"), 1);

  // Brand: General by default, then the project's own
  assert.equal(assets.setBrand({ ...assets.brand(), name: "Studio" }).hasOwnProperty("error"), false);
  assert.equal(assets.brand("gamface-aaaa").name, "Studio");
  assert.equal(assets.hasOwnBrand("gamface-aaaa"), false);
  const logo = assets.add({ name: "Gamface logo", data: PNG, project: "gamface-aaaa", role: "logo" });
  if ("error" in logo) throw new Error(logo.error);
  // A project's logo can't be the General brand's
  assert.match((assets.setBrand({ ...assets.brand(), logo: logo.id }) as { error: string }).error, /General one/);
  const own = assets.setBrand({ ...assets.brand(), name: "Gamface", accent: "#ff0055", logo: logo.id }, "gamface-aaaa");
  assert.ok(!("error" in own));
  assert.equal(assets.brand("gamface-aaaa").name, "Gamface");
  assert.equal(assets.brand(null).name, "Studio");
  assert.equal(assets.brand("side-bbbb").name, "Studio");
  assert.deepEqual(assets.brandAssets("gamface-aaaa").map((a) => a.id), [logo.id]);
  assert.match((assets.setBrand({ ...assets.brand(), logo: theirs.id }, "gamface-aaaa") as { error: string }).error, /logo/);
  // Survives a restart; deleting the logo clears it from the project's brand
  const again = new Assets((assets as unknown as { dir: string }).dir.replace(/\/assets$/, ""));
  assert.equal(again.brand("gamface-aaaa").accent, "#ff0055");
  again.remove(logo.id);
  assert.equal(again.brand("gamface-aaaa").logo, null);
  again.clearBrand("gamface-aaaa");
  assert.equal(again.brand("gamface-aaaa").name, "Studio");
});

test("a project kept on this PC sends every model call to a local model", () => {
  process.env.FAKE_CLOUD_KEY = "k";
  const store = new TaskStore(":memory:");
  const models = new ModelRegistry(store, { model: "qwen3:14b", fastModel: "qwen3:4b", numCtx: 8192, think: false });
  const notices = new Notices(store);
  const gateway = new ModelGateway(models, store, notices);
  assert.equal(
    models.update({
      customProviders: [
        { id: "cloudy", name: "Fake cloud", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "FAKE_CLOUD_KEY" },
        { id: "localbox", name: "Fake local", baseUrl: "http://127.0.0.1:9/v1", local: true },
      ],
      roles: { planner: { model: "cloudy/big", fallback: "localbox/small" } } as never,
    }),
    null,
  );
  const msgs = [{ role: "user" as const, content: "hello" }];
  // Outside a project (or in an ordinary one) the cloud model is used
  assert.equal(gateway.prepare("planner", msgs, models.resolve("planner")).r.provider.local, false);
  const ordinary = projectScope.run({ id: "gamface-aaaa", name: "Gamface", localOnly: false }, () => gateway.prepare("planner", msgs, models.resolve("planner")));
  assert.equal(ordinary.r.provider.local, false);
  const kept = projectScope.run({ id: "side-bbbb", name: "Side gig", localOnly: true }, () => gateway.prepare("planner", msgs, models.resolve("planner")));
  assert.equal(kept.r.provider.local, true);
  assert.match(kept.notes[0], /“Side gig” is kept on this PC/);
  assert.ok(notices.list().some((n) => n.kind === "local-only"));
});
