// Projects: separate workspaces on one Mission Control. Each project has its own
// instructions (added to every agent's prompt), memories, activity log, skills,
// assets and brand, browser sign-ins and routines. Cards outside any project are
// "General" (project null). General memories, skills and assets are shared with every
// project; a project's own are seen only inside it.
//
// A project can be kept on this PC: every model call made for it uses a local model,
// whatever the agents' settings say (enforced in the gateway through projectScope).

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { PROJECT_ID } from "../schemas/agent";
import { privateBlock } from "./privacy";
import { JsonStore } from "./store";

export const MAX_PROJECTS = 50;
const HEX = /^#[0-9a-fA-F]{6}$/;

export const ProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(HEX).default("#22d3ee"),
  // Added to every agent's prompt on this project's cards
  instructions: z.string().trim().max(4000).default(""),
  // Every model call for this project stays on a local model
  localOnly: z.boolean().default(false),
  archived: z.boolean().default(false),
  // Browser profiles (sign-ins) that belong to this project; others are shared
  profiles: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).max(20).default([]),
});
export const ProjectPatchSchema = ProjectInputSchema.partial();
export type ProjectInput = z.input<typeof ProjectInputSchema>;

export interface Project extends z.infer<typeof ProjectInputSchema> {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** The project the current model call is for, set around each card's run. */
export interface ProjectScope {
  id: string | null;
  name: string;
  localOnly: boolean;
}
export const projectScope = new AsyncLocalStorage<ProjectScope>();

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "") || "project";

export class Projects {
  private store: JsonStore<Project[]>;

  constructor(dataDir: string) {
    this.store = new JsonStore<Project[]>(dataDir, "projects.json", []);
  }

  list(includeArchived = true): Project[] {
    return this.store.data.filter((p) => includeArchived || !p.archived).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string | null | undefined): Project | undefined {
    return id && PROJECT_ID.test(id) ? this.store.data.find((p) => p.id === id) : undefined;
  }

  exists(id: string): boolean {
    return Boolean(this.get(id));
  }

  /** The id, or null when the id isn't a project (General). */
  idOf(id: string | null | undefined): string | null {
    return this.get(id)?.id ?? null;
  }

  name(id: string | null | undefined): string {
    return this.get(id)?.name ?? "General";
  }

  private clash(name: string, except?: string): Project | undefined {
    const n = name.trim().toLowerCase();
    return this.store.data.find((p) => p.id !== except && p.name.toLowerCase() === n);
  }

  /** The project a browser profile belongs to, if any. */
  ownerOfProfile(profile: string): Project | undefined {
    return this.store.data.find((p) => p.profiles.includes(profile));
  }

  private profileClash(profiles: string[], except?: string): string | null {
    for (const name of profiles) {
      const owner = this.ownerOfProfile(name);
      if (owner && owner.id !== except) return `The profile “${name}” already belongs to the project “${owner.name}”`;
    }
    return null;
  }

  create(input: unknown): Project | { error: string } {
    const parsed = ProjectInputSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "project"}: ${i.message}`).join("; ") };
    if (this.store.data.length >= MAX_PROJECTS) return { error: `At most ${MAX_PROJECTS} projects` };
    if (parsed.data.name.toLowerCase() === "general") return { error: "“General” is where cards outside any project live; pick another name" };
    if (this.clash(parsed.data.name)) return { error: `There's already a project called “${parsed.data.name}”` };
    const owned = this.profileClash(parsed.data.profiles);
    if (owned) return { error: owned };
    const now = Date.now();
    const p: Project = { ...parsed.data, profiles: [...new Set(parsed.data.profiles)], id: `${slug(parsed.data.name)}-${crypto.randomBytes(2).toString("hex")}`, createdAt: now, updatedAt: now };
    this.store.data.push(p);
    this.store.save();
    return p;
  }

  update(id: string, input: unknown): Project | { error: string } {
    const p = this.get(id);
    if (!p) return { error: "Project not found" };
    const parsed = ProjectPatchSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "project"}: ${i.message}`).join("; ") };
    const d = parsed.data;
    if (d.name !== undefined) {
      if (d.name.toLowerCase() === "general") return { error: "“General” is reserved; pick another name" };
      if (this.clash(d.name, id)) return { error: `There's already a project called “${d.name}”` };
    }
    if (d.profiles) {
      const owned = this.profileClash(d.profiles, id);
      if (owned) return { error: owned };
      d.profiles = [...new Set(d.profiles)];
    }
    Object.assign(p, d, { updatedAt: Date.now() });
    this.store.save();
    return p;
  }

  remove(id: string): boolean {
    const before = this.store.data.length;
    this.store.data = this.store.data.filter((p) => p.id !== id);
    if (this.store.data.length === before) return false;
    this.store.save();
    return true;
  }

  /** Forgets a deleted browser profile. */
  dropProfile(profile: string) {
    let changed = false;
    for (const p of this.store.data) {
      if (p.profiles.includes(profile)) {
        p.profiles = p.profiles.filter((x) => x !== profile);
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  scope(id: string | null | undefined): ProjectScope {
    const p = this.get(id);
    return p ? { id: p.id, name: p.name, localOnly: p.localOnly } : { id: null, name: "General", localOnly: false };
  }
}

/** Whether an item belonging to `owner` (null = General) may be used on a card of `project`. */
export const visibleIn = (owner: string | null | undefined, project: string | null | undefined) => !owner || owner === (project ?? null);

/**
 * The project's part of the system prompt: its instructions and its note from the
 * Obsidian vault (HQ/projects/<name>.md). Stable between calls, so the prompt cache
 * keeps working. The vault note is private, like the other vault notes.
 */
export function projectPrompt(p: Project | undefined, vault: string, limit = 3000): string {
  if (!p) return "";
  let out = `\n\nPROJECT: you're working in the project “${p.name}”.`;
  if (p.instructions) out += ` The user's instructions for this project:\n${p.instructions}`;
  const note = projectNote(vault, p.name);
  if (note) out += privateBlock(`\n\nPROJECT NOTES FROM THE VAULT:\n${note.slice(0, limit)}`);
  return out;
}

/** HQ/projects/<name>.md in the vault, if it exists. */
export function projectNote(vault: string, name: string): string {
  if (!vault) return "";
  const safe = name.replace(/[^\w \-]/g, "").trim();
  if (!safe) return "";
  const file = path.join(vault, "HQ", "projects", `${safe}.md`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
