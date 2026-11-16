// Workspaces and the change history (undo / redo).   npm test
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Changes } from "../src/hq/changes";
import type { Root } from "../src/hq/changes";
import { diffLines, hunks, unified } from "../src/hq/diff";
import { TaskStore } from "../src/hq/taskstore";
import { Workspace, extractFileOps, isSecretPath, namedWorkspace, workspaceBlock } from "../src/hq/workspace";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "ws-"));

test("diffs are minimal and their hunks rebuild both sides", () => {
  for (let t = 0; t < 500; t++) {
    const r = () => Array.from({ length: Math.floor(Math.random() * 15) }, () => "abcd"[Math.floor(Math.random() * 4)]);
    const a = r();
    const b = r();
    const s = diffLines(a, b);
    assert.deepEqual(s.filter((l) => l.op !== "+").map((l) => l.text), a);
    assert.deepEqual(s.filter((l) => l.op !== "-").map((l) => l.text), b);
  }
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 3\n", "line three\n");
  const h = hunks(before, after);
  assert.equal(h.added, 1);
  assert.equal(h.removed, 1);
  assert.deepEqual([h.hunks[0].aStart, h.hunks[0].aLines], [1, 6]);
  assert.match(unified("a.txt", before, after), /@@ -1,6 \+1,6 @@\n line 1\n line 2\n-line 3\n\+line three/);
  assert.match(unified("n.txt", null, "x\n"), /^--- \/dev\/null/);
});

test("workspace paths stay inside, and secret files are off limits", () => {
  const base = tmp();
  const ws = namedWorkspace("gamface", base);
  ws.ensure();
  assert.throws(() => namedWorkspace("../etc", base));
  assert.throws(() => namedWorkspace("/abs", base));
  for (const bad of ["../x", "/etc/passwd", "a/../../x", "C:/x", "a//b", "./"]) assert.ok("error" in ws.resolve(bad), bad);
  for (const secret of [".env", "app/.env.local", "certs/server.pem", "id_rsa", ".npmrc", "config/secrets.json", ".git/config", "x/.ssh/known_hosts"]) {
    assert.ok(isSecretPath(secret), secret);
    assert.ok("error" in ws.write(secret, "x"), secret);
  }
  assert.equal(isSecretPath(".env.example"), false);
  assert.equal(isSecretPath("src/keyboard.ts"), false);
  // A symlink leading out of the workspace is refused
  const outside = tmp();
  writeFileSync(path.join(outside, "victim.txt"), "keep me");
  symlinkSync(outside, path.join(ws.root, "link"));
  assert.match((ws.write("link/victim.txt", "pwned") as { error: string }).error, /outside the workspace/);
  assert.equal(readFileSync(path.join(outside, "victim.txt"), "utf8"), "keep me");
  // Ordinary files work; deleting tidies empty folders
  assert.deepEqual(ws.write("src/deep/a.ts", "export {};\n"), { rel: "src/deep/a.ts" });
  assert.deepEqual(ws.read("src/deep/a.ts"), { text: "export {};\n" });
  assert.deepEqual(ws.read("missing.ts"), { text: null });
  ws.write("src/deep/a.ts", null);
  assert.equal(existsSync(path.join(ws.root, "src")), false);
  // Binary files aren't read
  writeFileSync(path.join(ws.root, "img.bin"), Buffer.from([1, 0, 2]));
  assert.match((ws.read("img.bin") as { error: string }).error, /binary/);
});

test("the tree skips build folders and secrets; the block shows small workspaces whole", () => {
  const ws = namedWorkspace("site", tmp());
  ws.ensure();
  ws.write("index.html", "<h1>Hi</h1>\n");
  ws.write("src/app.js", "console.log(1)\n");
  mkdirSync(path.join(ws.root, "node_modules/x"), { recursive: true });
  writeFileSync(path.join(ws.root, "node_modules/x/i.js"), "x");
  writeFileSync(path.join(ws.root, ".env"), "KEY=secret");
  assert.deepEqual(ws.tree().files.map((f) => f.path), ["index.html", "src/app.js"]);
  const block = workspaceBlock(ws, "make the heading blue");
  assert.match(block, /WORKSPACE "site"/);
  assert.match(block, /----- index.html -----\n<h1>Hi<\/h1>/);
  assert.match(block, /```file path=relative\/path\/name.ext/);
  assert.doesNotMatch(block, /KEY=secret/);
  // A big workspace shows only the files named in the request
  for (let i = 0; i < 30; i++) ws.write(`pages/p${i}.html`, "x".repeat(200) + "\n");
  const named = workspaceBlock(ws, "fix the typo in pages/p7.html", 4000);
  assert.match(named, /----- pages\/p7.html -----/);
  assert.doesNotMatch(named, /----- pages\/p8.html -----/);
});

test("file blocks are read from an answer (last one for a path wins)", () => {
  const answer = [
    "Here you go:",
    "```file path=src/a.ts\nexport const a = 1;\n```",
    '```file path="docs/read me.md" lang=md\n# Hi\n```',
    "```delete path=old.txt\n```",
    "```file path=src/a.ts\nexport const a = 2;\n```",
    "```ts\nnot a file block\n```",
  ].join("\n");
  assert.deepEqual(extractFileOps(answer), [
    { path: "src/a.ts", text: "export const a = 2;\n" },
    { path: "docs/read me.md", text: "# Hi\n" },
    { path: "old.txt", text: null },
  ]);
  assert.deepEqual(extractFileOps("no blocks"), []);
});

function setup() {
  const base = tmp();
  const vault = tmp();
  const store = new TaskStore(":memory:");
  const access = (r: Root) => (r.kind === "vault" ? new Workspace("vault", vault) : namedWorkspace(r.name, base));
  const changes = new Changes(store.sql, tmp(), access);
  const ws = namedWorkspace("gamface", base);
  ws.ensure();
  return { changes, ws, vault, root: { kind: "workspace", name: "gamface" } as Root };
}

test("changes are recorded with diffs, undone, redone, and conflicts ask first", () => {
  const { changes, ws, root } = setup();
  ws.write("keep.txt", "untouched\n");
  ws.write("app.ts", "const a = 1;\n");
  const first = changes.apply({ taskId: "t1", project: "gamface-aaaa", label: "Card one", root }, [
    { path: "app.ts", text: "const a = 2;\n" },
    { path: "new.md", text: "# New\n" },
    { path: "keep.txt", text: "untouched\n" }, // same content: left out
    { path: ".env", text: "X=1" }, // refused
  ]);
  assert.ok(first.set);
  assert.equal(first.errors.length, 1);
  assert.deepEqual(first.set!.files.map((f) => [f.path, f.before === null, f.added, f.removed]), [
    ["app.ts", false, 1, 1],
    ["new.md", true, 1, 0],
  ]);
  const d = changes.detail(first.set!.id)!;
  assert.equal(d.files[0].hunks[0].lines.map((l) => l.op + l.text).join("|"), "-const a = 1;|+const a = 2;");
  assert.deepEqual(changes.conflicts(first.set!), []);

  // A later card changes the same file: undoing the first now asks
  const second = changes.apply({ taskId: "t2", project: "gamface-aaaa", label: "Card two", root }, [{ path: "app.ts", text: "const a = 3;\n" }]);
  assert.deepEqual(changes.undo(first.set!.id), { conflicts: ["app.ts"] });
  assert.equal(ws.read("app.ts").hasOwnProperty("text") && (ws.read("app.ts") as { text: string }).text, "const a = 3;\n");

  // Undo the second, then the first, cleanly
  const u2 = changes.undo(second.set!.id);
  assert.ok("set" in u2);
  assert.deepEqual(ws.read("app.ts"), { text: "const a = 2;\n" });
  const u1 = changes.undo(first.set!.id);
  assert.ok("set" in u1);
  assert.deepEqual(ws.read("app.ts"), { text: "const a = 1;\n" });
  assert.deepEqual(ws.read("new.md"), { text: null });
  assert.equal(changes.get(first.set!.id)!.undoneBy, (u1 as { set: { id: string } }).set.id);
  assert.match((changes.undo(first.set!.id) as { error: string }).error, /Already undone/);

  // Redo = undo the undo
  const redo = changes.undo((u1 as { set: { id: string } }).set.id);
  assert.ok("set" in redo);
  assert.match(redo.set.label, /^Redo: Card one/);
  assert.deepEqual(ws.read("app.ts"), { text: "const a = 2;\n" });
  assert.deepEqual(ws.read("new.md"), { text: "# New\n" });
  assert.equal(changes.get(first.set!.id)!.undoneBy, undefined, "the original counts as applied again");

  // Forcing past a conflict keeps the overwritten work in the history
  ws.write("app.ts", "edited by hand\n");
  const forced = changes.undo(redo.set.id, true);
  assert.ok("set" in forced);
  assert.deepEqual(ws.read("app.ts"), { text: "const a = 1;\n" });
  assert.equal(changes.blob(forced.set.files.find((f) => f.path === "app.ts")!.before), "edited by hand\n");

  // Listing
  assert.equal(changes.list({ taskId: "t1" }).length, 4);
  assert.equal(changes.list({ project: "gamface-aaaa" }).length, 6);
  assert.equal(changes.list({ project: null }).length, 0);
  changes.moveProject("gamface-aaaa", null);
  assert.equal(changes.list({ project: null }).length, 6);
});

test("vault notes the agents create can be undone too", () => {
  const { changes, vault } = setup();
  mkdirSync(path.join(vault, "HQ", "inbox"), { recursive: true });
  writeFileSync(path.join(vault, "HQ", "inbox", "note.md"), "Remember the launch\n");
  const set = changes.recordCreated({ taskId: "t9", project: null, label: "Notes", root: { kind: "vault" } }, [{ path: "HQ/inbox/note.md", text: "Remember the launch\n" }]);
  assert.ok(set);
  const u = changes.undo(set!.id);
  assert.ok("set" in u);
  assert.equal(existsSync(path.join(vault, "HQ", "inbox", "note.md")), false);
  changes.undo((u as { set: { id: string } }).set.id);
  assert.equal(readFileSync(path.join(vault, "HQ", "inbox", "note.md"), "utf8"), "Remember the launch\n");
});
