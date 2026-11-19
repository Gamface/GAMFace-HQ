// Mission Control's own code, read-only. Reads the committed code of the GAMFace-HQ repository
// through git, from its .git folder mounted read-only at CODE_GIT_DIR (/code.git). Only what's
// committed is visible: .env files and data/ are git-ignored, so keys and your notes can't be
// read, and nothing here can change the repository.
//
// Tools: list_files, read_file, search_code, recent_changes, show_commit.

import { execFile } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const GIT_DIR = process.env.CODE_GIT_DIR || "/code.git";
const MAX_OUT = 60_000;

/** A repository path: relative, no "..", no leading dash. Exported for tests. */
export function cleanPath(p = "") {
  const s = String(p).trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (s.startsWith("-") || s.split("/").includes("..") || /[\0\n]/.test(s) || s.length > 300) throw new Error(`Not a usable path: ${p}`);
  return s;
}

/** A commit, branch or tag name (HEAD, main, a sha, HEAD~3). Exported for tests. */
export function cleanRef(r = "HEAD") {
  const s = String(r || "HEAD").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,99}$/.test(s) || s.includes("..")) throw new Error(`Not a usable commit or branch name: ${r}`);
  return s;
}

/** Runs a read-only git command against the mounted repository (no shell). Exported for tests. */
export function git(args, { gitDir = GIT_DIR, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", `--git-dir=${gitDir}`, ...args],
      { maxBuffer: 8 * 1024 * 1024, timeout: 20_000, env: { PATH: process.env.PATH, HOME: "/tmp", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        if (!okCodes.includes(code)) return reject(new Error(String(stderr || err?.message || "git failed").trim().split("\n")[0]));
        resolve(stdout);
      },
    );
  });
}

const cap = (text) => (text.length > MAX_OUT ? `${text.slice(0, MAX_OUT)}\n[cut: ${text.length - MAX_OUT} more characters]` : text);
const ok = (text) => ({ content: [{ type: "text", text: cap(text) || "(nothing)" }] });
const fail = (e) => ({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });

/** Files under a folder at a commit, at most `limit`. Exported for tests. */
export async function listFiles({ path = "", ref = "HEAD", limit = 400 }, opts) {
  const dir = cleanPath(path);
  const out = await git(["ls-tree", "-r", "--name-only", cleanRef(ref), ...(dir ? ["--", dir] : [])], opts);
  const files = out.split("\n").filter(Boolean);
  return files.length > limit ? `${files.slice(0, limit).join("\n")}\n[${files.length - limit} more files: list a sub-folder]` : files.join("\n");
}

/** A file's lines (numbered) at a commit. Exported for tests. */
export async function readFile({ path, ref = "HEAD", start_line = 1, end_line }, opts) {
  const p = cleanPath(path);
  if (!p) throw new Error("Give a file path");
  const lines = (await git(["show", `${cleanRef(ref)}:${p}`], opts)).split("\n");
  const from = Math.max(1, start_line);
  const to = Math.min(lines.length, end_line ?? from + 399);
  const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join("\n");
  return `${p} (lines ${from}-${to} of ${lines.length}${to < lines.length ? "; ask for more with start_line" : ""})\n${body}`;
}

/** Lines matching a pattern (extended regex, case-insensitive) at a commit. Exported for tests. */
export async function searchCode({ pattern, path = "", ref = "HEAD", limit = 100 }, opts) {
  if (!pattern || pattern.length > 200) throw new Error("Give a search pattern (up to 200 characters)");
  const r = cleanRef(ref);
  const dir = cleanPath(path);
  // Exit code 1 means no matches
  const out = await git(["grep", "-n", "-I", "-i", "-E", "-e", pattern, r, ...(dir ? ["--", dir] : [])], { ...opts, okCodes: [0, 1] });
  const hits = out.split("\n").filter(Boolean).map((l) => (l.startsWith(`${r}:`) ? l.slice(r.length + 1) : l));
  if (!hits.length) return `No matches for /${pattern}/${dir ? ` in ${dir}` : ""}.`;
  return hits.length > limit ? `${hits.slice(0, limit).join("\n")}\n[${hits.length - limit} more matches: narrow the pattern or path]` : hits.join("\n");
}

/** The latest commits with the files they changed. Exported for tests. */
export async function recentChanges({ count = 10, path = "" }, opts) {
  const dir = cleanPath(path);
  return git(["log", `-n${Math.min(50, Math.max(1, count))}`, "--date=short", "--format=%h %ad %an: %s", "--shortstat", ...(dir ? ["--", dir] : [])], opts);
}

/** One commit: its message, the files it changed and its diff (capped). Exported for tests. */
export async function showCommit({ ref }, opts) {
  return git(["show", "--stat", "--patch", "--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B", cleanRef(ref)], opts);
}

const run = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

const server = new McpServer({ name: "code", version: "1.0.0" });
const readOnly = { readOnlyHint: true, openWorldHint: false };
const ref = z.string().max(100).optional().describe("Commit, branch or tag (default HEAD, the latest commit)");

server.registerTool(
  "list_files",
  { description: "List Mission Control's (GAMFace-HQ's) own source files, optionally under a folder (e.g. mission-control/src/hq).", inputSchema: { path: z.string().max(300).optional().describe("Folder in the repository"), ref }, annotations: readOnly },
  run(listFiles),
);
server.registerTool(
  "read_file",
  {
    description: "Read one of Mission Control's own source files, with line numbers (400 lines at a time).",
    inputSchema: { path: z.string().min(1).max(300).describe("File path in the repository, e.g. mission-control/src/hq/team.ts"), ref, start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() },
    annotations: readOnly,
  },
  run(readFile),
);
server.registerTool(
  "search_code",
  {
    description: "Search Mission Control's own code for a word or regular expression (case-insensitive); returns file:line: text.",
    inputSchema: { pattern: z.string().min(1).max(200).describe("Text or extended regular expression"), path: z.string().max(300).optional().describe("Only search under this folder"), ref },
    annotations: readOnly,
  },
  run(searchCode),
);
server.registerTool(
  "recent_changes",
  { description: "The latest commits to Mission Control's code (who, when, what, how much changed).", inputSchema: { count: z.number().int().min(1).max(50).optional(), path: z.string().max(300).optional().describe("Only commits touching this path") }, annotations: readOnly },
  run(recentChanges),
);
server.registerTool(
  "show_commit",
  { description: "Show one commit of Mission Control's code: message, changed files and the diff.", inputSchema: { ref: z.string().min(1).max(100).describe("Commit sha (short is fine), branch, tag or HEAD~n") }, annotations: readOnly },
  run(showCommit),
);

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  await server.connect(new StdioServerTransport());
}
