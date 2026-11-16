// Workspaces: the folders the Coder and File agents may edit. Each project has one
// under WORKSPACES_DIR (General uses "general"); point WORKSPACES_DIR at a mounted
// folder to let them work on your own repos. Every path is checked to stay inside the
// workspace (no "..", no absolute paths, no symlinks leading out), and secret files
// (.env, keys, credentials) are never read or written.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_FILE_BYTES = 256 * 1024;
const MAX_TREE = 400;
// Folders not worth showing an agent
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".nuxt", "out", "coverage", "__pycache__", ".venv", "venv", ".cache", ".turbo", ".idea", ".vscode", "target"]);
export const WORKSPACE_NAME = /^[A-Za-z0-9_][\w.-]{0,63}(\/[A-Za-z0-9_][\w.-]{0,63}){0,3}$/;

/** Files an agent never reads or writes. */
export function isSecretPath(rel: string): boolean {
  const base = rel.split("/").pop() ?? "";
  return (
    /^\.env(\..*)?$/i.test(base) && !/\.(example|sample|template)$/i.test(base) ||
    /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i.test(base) ||
    /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i.test(base) ||
    /^(\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i.test(base) ||
    rel.split("/").includes(".git") ||
    rel.split("/").includes(".ssh")
  );
}

/** The workspace called `name` under `baseDir` (names are checked). */
export function namedWorkspace(name: string, baseDir: string): Workspace {
  if (!WORKSPACE_NAME.test(name) || name.split("/").includes("..")) throw new Error(`Bad workspace name: ${name}`);
  return new Workspace(name, path.resolve(baseDir, name));
}

export class Workspace {
  readonly root: string;

  constructor(
    readonly name: string,
    root: string,
  ) {
    this.root = path.resolve(root);
  }

  ensure() {
    mkdirSync(this.root, { recursive: true });
  }

  /** The absolute path for a relative one, or an error when it isn't allowed. */
  resolve(rel: string): { abs: string; rel: string } | { error: string } {
    const clean = rel.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (!clean || clean.startsWith("/") || /^[a-z]:/i.test(clean)) return { error: `“${rel}” must be a path inside the workspace` };
    const parts = clean.split("/");
    if (parts.some((p) => p === ".." || p === "." || p === "")) return { error: `“${rel}” isn't allowed (no .. or empty parts)` };
    if (clean.length > 300) return { error: "Path too long" };
    if (isSecretPath(clean)) return { error: `“${clean}” looks like a secrets file; agents never touch those` };
    const abs = path.join(this.root, clean);
    // Symlinks must not lead out of the workspace: check the deepest existing parent
    let probe = abs;
    while (!existsSync(probe) && probe !== this.root) probe = path.dirname(probe);
    if (existsSync(probe)) {
      const real = realpathSync(probe);
      const rootReal = existsSync(this.root) ? realpathSync(this.root) : this.root;
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { error: `“${clean}” leads outside the workspace` };
    }
    return { abs, rel: clean };
  }

  /** The file's text, or null when it doesn't exist. Binary and huge files are refused. */
  read(rel: string): { text: string | null } | { error: string } {
    const r = this.resolve(rel);
    if ("error" in r) return r;
    if (!existsSync(r.abs)) return { text: null };
    const st = lstatSync(r.abs);
    if (st.isSymbolicLink() || !st.isFile()) return { error: `“${r.rel}” isn't a regular file` };
    if (st.size > MAX_FILE_BYTES) return { error: `“${r.rel}” is larger than ${MAX_FILE_BYTES / 1024} KB` };
    const buf = readFileSync(r.abs);
    if (buf.includes(0)) return { error: `“${r.rel}” is a binary file` };
    return { text: buf.toString("utf8") };
  }

  /** Writes text (null deletes). */
  write(rel: string, text: string | null): { rel: string } | { error: string } {
    const r = this.resolve(rel);
    if ("error" in r) return r;
    if (text !== null && Buffer.byteLength(text) > MAX_FILE_BYTES) return { error: `“${r.rel}” would be larger than ${MAX_FILE_BYTES / 1024} KB` };
    if (existsSync(r.abs)) {
      const st = lstatSync(r.abs);
      if (st.isSymbolicLink() || st.isDirectory()) return { error: `“${r.rel}” isn't a regular file` };
    }
    if (text === null) {
      rmSync(r.abs, { force: true });
      // Tidy up folders the delete left empty
      let dir = path.dirname(r.abs);
      while (dir !== this.root && dir.startsWith(this.root) && existsSync(dir) && readdirSync(dir).length === 0) {
        rmdirSync(dir);
        dir = path.dirname(dir);
      }
    } else {
      mkdirSync(path.dirname(r.abs), { recursive: true });
      writeFileSync(r.abs, text);
    }
    return { rel: r.rel };
  }

  /** Files in the workspace (skipping build folders and secrets), at most MAX_TREE. */
  tree(limit = MAX_TREE): { files: { path: string; bytes: number }[]; truncated: boolean } {
    const files: { path: string; bytes: number }[] = [];
    if (!existsSync(this.root)) return { files, truncated: false };
    let truncated = false;
    const walk = (dir: string, prefix: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const name of entries) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        const abs = path.join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name)) walk(abs, rel);
        } else if (st.isFile() && !isSecretPath(rel)) files.push({ path: rel, bytes: st.size });
      }
    };
    walk(this.root, "");
    return { files, truncated };
  }

  exists(): boolean {
    return existsSync(this.root) && statSync(this.root).isDirectory();
  }
}

/** File blocks an agent wrote: ```file path=src/a.ts … ``` and ```delete path=old.txt``` */
export function extractFileOps(answer: string): { path: string; text: string | null }[] {
  const ops = new Map<string, string | null>();
  const re = /```(file|delete)[ \t]+path=("([^"\n]+)"|'([^'\n]+)'|(\S+))[^\n]*\n([\s\S]*?)```/g;
  for (const m of answer.matchAll(re)) {
    const p = (m[3] ?? m[4] ?? m[5]).trim();
    if (m[1] === "delete") ops.set(p, null);
    else ops.set(p, m[6].replace(/\n$/, "") + "\n");
  }
  return [...ops].map(([p, text]) => ({ path: p, text }));
}

/** What the agent is told about the workspace: its files and the contents of the relevant ones. */
export function workspaceBlock(ws: Workspace, request: string, budget = 40_000): string {
  const { files, truncated } = ws.tree();
  const lower = request.toLowerCase();
  // Files named in the request (by path or by file name) first; a small workspace is shown whole
  const named = files.filter((f) => lower.includes(f.path.toLowerCase()) || (f.path.split("/").pop()!.length > 3 && lower.includes(f.path.split("/").pop()!.toLowerCase())));
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const show = total <= budget / 2 && files.length <= 25 ? files : named;
  const parts: string[] = [];
  let used = 0;
  for (const f of show) {
    if (used + f.bytes > budget) continue;
    const r = ws.read(f.path);
    if ("error" in r || r.text === null) continue;
    used += f.bytes;
    parts.push(`----- ${f.path} -----\n${r.text}`);
  }
  return (
    `\n\nWORKSPACE "${ws.name}": you can create, change and delete files in it. ${files.length ? `Its files${truncated ? " (first " + files.length + ")" : ""}:\n${files.map((f) => `  ${f.path} (${f.bytes} B)`).join("\n")}` : "It's empty."}` +
    (parts.length ? `\n\nCurrent contents of ${show === files ? "every file" : "the files named in the request"}:\n${parts.join("\n")}` : "") +
    "\n\nTo change files, put each file's ENTIRE new content in its own block, then explain what you did:\n" +
    "```file path=relative/path/name.ext\n…the whole file…\n```\n" +
    "To delete a file: ```delete path=relative/path/name.ext\n```\n" +
    "Paths are relative to the workspace (no leading /, no ..). Only the files you put in blocks change; every change can be undone by the user. " +
    "Secret files (.env, keys) can't be read or written. If you need to see a file whose contents aren't shown, say which, and don't guess its contents."
  );
}
