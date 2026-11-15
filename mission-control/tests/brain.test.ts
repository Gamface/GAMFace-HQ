// Brain pieces that need no database: vault notes → canon docs.   npm test
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseFrontmatter, readVaultCanon, toCanonNote } from "../src/brain/canon-sync";

test("frontmatter is split from the body", () => {
  const { meta, body } = parseFrontmatter("---\ntitle: \"Company profile\"\ncloud: yes\n---\n# Heading\n\nText");
  assert.deepEqual(meta, { title: "Company profile", cloud: "yes" });
  assert.equal(body, "# Heading\n\nText");
  assert.deepEqual(parseFrontmatter("no frontmatter").meta, {});
});

test("vault notes are private unless their frontmatter says cloud: true", () => {
  const privateNote = toCanonNote("HQ/shared.md", "# Shared notes\n\nMy home lab is at 192.168.4.90.\n\nMore.");
  assert.equal(privateNote.private, true);
  assert.equal(privateNote.slug, "vault-hq-shared");
  assert.equal(privateNote.title, "Shared notes");
  assert.equal(privateNote.summary, "My home lab is at 192.168.4.90.");

  const shared = toCanonNote("HQ/agents/coder.md", "---\ncloud: true\nsummary: Coding standards\n---\nUse TypeScript.");
  assert.equal(shared.private, false);
  assert.equal(shared.slug, "vault-hq-agents-coder");
  assert.equal(shared.title, "coder");
  assert.equal(shared.summary, "Coding standards");
  assert.equal(shared.content, "Use TypeScript.");
});

test("the vault reader takes HQ/ notes and skips agent output folders", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "vault-"));
  mkdirSync(path.join(vault, "HQ", "agents"), { recursive: true });
  mkdirSync(path.join(vault, "HQ", "inbox"), { recursive: true });
  mkdirSync(path.join(vault, "HQ", "routines"), { recursive: true });
  mkdirSync(path.join(vault, "Personal"), { recursive: true });
  writeFileSync(path.join(vault, "HQ", "shared.md"), "# Shared");
  writeFileSync(path.join(vault, "HQ", "agents", "planner.md"), "# Jarvis");
  writeFileSync(path.join(vault, "HQ", "inbox", "2026-11-15 note.md"), "agent output");
  writeFileSync(path.join(vault, "HQ", "routines", "daily.md"), "routine output");
  writeFileSync(path.join(vault, "HQ", "picture.png"), "x");
  writeFileSync(path.join(vault, "Personal", "diary.md"), "not HQ");
  const { notes } = readVaultCanon(vault);
  assert.deepEqual(notes.map((n) => n.sourcePath).sort(), ["HQ/agents/planner.md", "HQ/shared.md"]);
  assert.deepEqual(readVaultCanon(path.join(vault, "missing")).notes, []);
});
