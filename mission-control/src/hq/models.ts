import type { Provider } from "./providers";
import { builtinProviders, normalizeRef, parseModelRef } from "./providers";
import { projectScope } from "./projects";
import type { TaskStore } from "./taskstore";

// Which model each agent uses. Settings live in the database (edited on the
// Team page or with "switch <agent> to <model>"), with defaults from .env.

export const MODEL_ROLES = ["planner", "coder", "browser", "file", "security_audit", "vision", "tools", "router", "memory", "audio"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface RoleSettings {
  /** Model reference, e.g. "ollama/qwen3:14b" or "openrouter/anthropic/claude-sonnet-4.5" */
  model: string;
  /** Used when the main model fails or hits its daily token limit */
  fallback?: string;
  numCtx?: number;
  temperature?: number;
  /** false switches reasoning off on models that support it */
  think?: boolean;
  /** Daily cap on tokens for cloud models; past it the fallback is used, or the default local model when there is none */
  dailyTokenLimit?: number;
  /** Never send this agent's requests to a cloud provider (checked on every request) */
  localOnly?: boolean;
  /** Let vault notes, memories and the hive log go to a cloud model (off: they are withheld) */
  allowPrivateToCloud?: boolean;
  /** Monthly spend cap in US dollars for this agent's cloud requests */
  monthlyBudgetUsd?: number;
  /**
   * How long one of this agent's tasks may run, in minutes, when that is longer
   * than TASK_TIMEOUT_MS. For slow models such as a large colibri model streamed from disk.
   */
  timeoutMinutes?: number;
}

/** US dollars per million tokens */
export interface ModelPrice {
  input: number;
  output: number;
}

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv?: string;
  local?: boolean;
}

export interface ModelSettings {
  roles: Record<ModelRole, RoleSettings>;
  /** Short names for "switch to <alias>", e.g. { local: "ollama/qwen3:14b", claude: "anthropic/claude-sonnet-4-5" } */
  aliases: Record<string, string>;
  customProviders: CustomProvider[];
  /** Prices for cloud models, keyed by model reference */
  prices: Record<string, ModelPrice>;
  /** Monthly spend cap across all agents, in US dollars */
  monthlyBudgetUsd?: number;
}

/** Agents that start out local-only: the File agent reads your vault, Memory handles your memories */
export const LOCAL_ONLY_BY_DEFAULT: readonly ModelRole[] = ["file", "memory", "audio"];

export interface Resolved {
  role: ModelRole;
  ref: string;
  provider: Provider;
  model: string;
  settings: RoleSettings;
}

export interface ModelDefaults {
  model: string;
  fastModel: string;
  numCtx: number;
  think: boolean;
  /** Default model for the vision agent (must be able to read images) */
  visionModel?: string;
  /** Default model for transcribing audio (must have the audio capability) */
  audioModel?: string;
  /** Overall monthly cap that applies until one is saved on the Team page (clearing it there means no cap) */
  monthlyBudgetUsd?: number;
  /** colibri models offered as the "colibri" and "colibri-big" aliases (only when colibri is configured) */
  colibriModel?: string;
  colibriBigModel?: string;
}

const ID_RE = /^[a-z][a-z0-9_-]{1,30}$/;

/** A saved team setup: which model (and fallback) each agent uses. */
export interface Preset {
  id: string;
  name: string;
  models: Partial<Record<ModelRole, { model: string; fallback?: string }>>;
  builtIn?: boolean;
}
export const MAX_PRESETS = 20;
export const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

export class ModelRegistry {
  private store: TaskStore;
  private defaults: ModelDefaults;

  constructor(store: TaskStore, defaults: ModelDefaults) {
    this.store = store;
    this.defaults = defaults;
  }

  private defaultSettings(): ModelSettings {
    const main = `ollama/${this.defaults.model}`;
    const fast = `ollama/${this.defaults.fastModel}`;
    const roles = {} as Record<ModelRole, RoleSettings>;
    for (const r of MODEL_ROLES) {
      const background = r === "router" || r === "memory";
      roles[r] = {
        model: background
          ? fast
          : r === "vision"
            ? `ollama/${this.defaults.visionModel ?? "qwen3.5:latest"}`
            : r === "audio"
              ? `ollama/${this.defaults.audioModel ?? "gemma4:12b"}`
              : main,
        numCtx: this.defaults.numCtx,
        think: background ? false : this.defaults.think,
        localOnly: LOCAL_ONLY_BY_DEFAULT.includes(r),
      };
    }
    const aliases: Record<string, string> = { local: main };
    if (this.defaults.colibriModel) aliases.colibri = `colibri/${this.defaults.colibriModel}`;
    if (this.defaults.colibriBigModel) aliases["colibri-big"] = `colibri/${this.defaults.colibriBigModel}`;
    return { roles, aliases, customProviders: [], prices: {} };
  }

  settings(): ModelSettings {
    const saved = this.store.getSetting<Partial<ModelSettings>>("models", {});
    const d = this.defaultSettings();
    return {
      roles: Object.fromEntries(MODEL_ROLES.map((r) => [r, { ...d.roles[r], ...(saved.roles?.[r] ?? {}) }])) as Record<ModelRole, RoleSettings>,
      aliases: { ...d.aliases, ...(saved.aliases ?? {}) },
      customProviders: saved.customProviders ?? [],
      prices: saved.prices ?? {},
      // Never saved: the default cap. Saved as null: the cap was cleared on purpose.
      monthlyBudgetUsd: saved.monthlyBudgetUsd === undefined ? this.defaults.monthlyBudgetUsd : (saved.monthlyBudgetUsd ?? undefined),
    };
  }

  providers(customList?: CustomProvider[]): Provider[] {
    const custom: Provider[] = (customList ?? this.settings().customProviders).map((c) => ({
      id: c.id,
      name: c.name,
      kind: "openai",
      baseUrl: c.baseUrl.replace(/\/+$/, ""),
      apiKeyEnv: c.apiKeyEnv || undefined,
      local: Boolean(c.local),
    }));
    return [...builtinProviders(), ...custom];
  }

  // --- Presets ------------------------------------------------------------------

  /** The built-in presets (from .env defaults) and the saved ones. */
  presets(): Preset[] {
    const d = this.defaultSettings();
    const local: Preset = { id: "local", name: "All local", builtIn: true, models: Object.fromEntries(MODEL_ROLES.map((r) => [r, { model: d.roles[r].model }])) };
    const fast = `ollama/${this.defaults.fastModel}`;
    const quick: Preset = {
      id: "fast",
      name: "Fast",
      builtIn: true,
      // Vision and audio keep their own models: a text model can't read pictures or hear audio
      models: Object.fromEntries(MODEL_ROLES.map((r) => [r, { model: r === "vision" || r === "audio" ? d.roles[r].model : fast }])),
    };
    // "Fast" only means something when the fast model isn't the main one
    return [local, ...(this.defaults.fastModel !== this.defaults.model ? [quick] : []), ...this.store.getSetting<Preset[]>("presets", [])];
  }

  preset(id: string): Preset | undefined {
    return this.presets().find((p) => p.id === id);
  }

  /** Checks a preset's models and fills in the provider names. */
  private cleanModels(models: unknown): Preset["models"] | string {
    if (!models || typeof models !== "object") return "A preset needs at least one agent's model";
    const providers = this.providers();
    const out: Preset["models"] = {};
    for (const [role, v] of Object.entries(models as Record<string, unknown>)) {
      if (!MODEL_ROLES.includes(role as ModelRole)) return `Unknown agent "${role}"`;
      const m = v as { model?: unknown; fallback?: unknown } | null;
      if (!m || typeof m.model !== "string") return `${role}: missing model`;
      const model = normalizeRef(m.model, providers);
      if (!model) return `No provider for "${m.model}"`;
      const fallback = typeof m.fallback === "string" && m.fallback ? normalizeRef(m.fallback, providers) : undefined;
      if (m.fallback && !fallback) return `No provider for fallback "${String(m.fallback)}"`;
      out[role as ModelRole] = fallback ? { model, fallback } : { model };
    }
    if (!Object.keys(out).length) return "A preset needs at least one agent's model";
    return out;
  }

  /** Saves a preset; without models, the team's current setup. */
  savePreset(name: string, models?: unknown, id?: string): Preset | { error: string } {
    const n = name.trim().slice(0, 40);
    if (!n) return { error: "Give the preset a name" };
    const saved = this.store.getSetting<Preset[]>("presets", []);
    const builtIns = this.presets().filter((p) => p.builtIn);
    if (id && builtIns.some((p) => p.id === id)) return { error: "Built-in presets can't be changed; save a copy under another name" };
    const existing = id ? saved.find((p) => p.id === id) : undefined;
    if (id && !existing) return { error: "Preset not found" };
    if (this.presets().some((p) => p.id !== id && p.name.toLowerCase() === n.toLowerCase())) return { error: `There's already a preset called “${n}”` };
    if (!existing && saved.length >= MAX_PRESETS) return { error: `At most ${MAX_PRESETS} presets` };
    const current = this.settings().roles;
    const raw = models ?? Object.fromEntries(MODEL_ROLES.map((r) => [r, { model: current[r].model, fallback: current[r].fallback }]));
    const clean = this.cleanModels(raw);
    if (typeof clean === "string") return { error: clean };
    let newId = existing?.id ?? (n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "preset");
    if (!existing) while (this.presets().some((p) => p.id === newId)) newId = `${newId.replace(/-\d+$/, "")}-${Math.floor(Math.random() * 900 + 100)}`;
    const preset: Preset = { id: newId, name: n, models: clean };
    this.store.setSetting("presets", existing ? saved.map((p) => (p.id === newId ? preset : p)) : [...saved, preset]);
    return preset;
  }

  removePreset(id: string): boolean {
    const saved = this.store.getSetting<Preset[]>("presets", []);
    if (!saved.some((p) => p.id === id)) return false;
    this.store.setSetting(
      "presets",
      saved.filter((p) => p.id !== id),
    );
    return true;
  }

  /**
   * Switches the team to a preset. Local-only agents keep their model when the preset
   * would give them a cloud one; they're listed in `skipped`.
   */
  applyPreset(id: string): { applied: ModelRole[]; skipped: { role: ModelRole; reason: string }[] } | { error: string } {
    const p = this.preset(id);
    if (!p) return { error: "Preset not found" };
    const settings = this.settings();
    const providers = this.providers();
    const roles: Partial<Record<ModelRole, Partial<RoleSettings>>> = {};
    const skipped: { role: ModelRole; reason: string }[] = [];
    for (const [role, m] of Object.entries(p.models) as [ModelRole, { model: string; fallback?: string }][]) {
      const cloud = [m.model, m.fallback].some((ref) => ref && !parseModelRef(ref, providers)?.provider.local);
      if (cloud && settings.roles[role].localOnly) {
        skipped.push({ role, reason: "local only" });
        continue;
      }
      if (!parseModelRef(m.model, providers)) {
        skipped.push({ role, reason: `no provider for ${m.model}` });
        continue;
      }
      // null clears a fallback the preset doesn't have
      roles[role] = { model: m.model, fallback: (m.fallback ?? null) as never };
    }
    const err = this.update({ roles: roles as Record<ModelRole, RoleSettings> });
    if (err) return { error: err };
    return { applied: Object.keys(roles) as ModelRole[], skipped };
  }

  /** The preset the team matches right now, if any. */
  activePreset(): Preset | undefined {
    const roles = this.settings().roles;
    return this.presets().find((p) =>
      (Object.entries(p.models) as [ModelRole, { model: string; fallback?: string }][]).every(([r, m]) => roles[r].model === m.model && (roles[r].fallback ?? undefined) === (m.fallback ?? undefined)),
    );
  }

  /** An agent's settings, with the project's preset (if the current card's project has one) on top. */
  private effective(role: ModelRole): RoleSettings {
    const s = this.settings().roles[role];
    const id = projectScope.getStore()?.preset;
    const over = id ? this.preset(id)?.models[role] : undefined;
    return over ? { ...s, model: over.model, fallback: over.fallback } : s;
  }

  /** Validates and saves a change. Returns an error message, or null on success. */
  update(change: Partial<ModelSettings>): string | null {
    const current = this.settings();
    const next: ModelSettings = {
      roles: { ...current.roles },
      aliases: change.aliases ?? current.aliases,
      customProviders: change.customProviders ?? current.customProviders,
      prices: change.prices ?? current.prices,
      // null (what JSON can carry) and undefined both clear the cap
      monthlyBudgetUsd: "monthlyBudgetUsd" in change ? (change.monthlyBudgetUsd ?? undefined) : current.monthlyBudgetUsd,
    };
    if (next.monthlyBudgetUsd !== undefined && (!(next.monthlyBudgetUsd >= 0) || next.monthlyBudgetUsd > 100000)) return "Monthly budget must be between $0 and $100,000";
    for (const c of next.customProviders) {
      if (!ID_RE.test(c.id)) return `Provider id "${c.id}" must be lowercase letters, digits, - or _`;
      if (["ollama", "lmstudio", "colibri", "openai", "openrouter", "anthropic", "gemini"].includes(c.id)) return `"${c.id}" is a built-in provider`;
      if (!/^https?:\/\//.test(c.baseUrl)) return `Provider "${c.id}" needs an http(s) base URL`;
      if (c.apiKeyEnv && !/^[A-Z][A-Z0-9_]{1,60}$/.test(c.apiKeyEnv)) return `API key variable "${c.apiKeyEnv}" should look like MY_PROVIDER_API_KEY`;
    }
    // Validate model references against the providers that will exist after this change
    const providers = this.providers(next.customProviders);
    for (const [role, s] of Object.entries(change.roles ?? {}) as [ModelRole, Partial<RoleSettings>][]) {
      if (!MODEL_ROLES.includes(role)) return `Unknown agent "${role}"`;
      // A null field clears that setting (JSON drops undefined, so the Team page sends null)
      const merged = { ...current.roles[role], ...s };
      for (const k of Object.keys(merged) as (keyof RoleSettings)[]) if (merged[k] === null) delete merged[k];
      const model = normalizeRef(merged.model, providers);
      if (!model) return `No provider for "${merged.model}"`;
      merged.model = model;
      if (merged.fallback) {
        const fb = normalizeRef(merged.fallback, providers);
        if (!fb) return `No provider for fallback "${merged.fallback}"`;
        merged.fallback = fb;
      }
      if (merged.numCtx !== undefined && (merged.numCtx < 512 || merged.numCtx > 262144)) return "Context size must be between 512 and 262144";
      if (merged.temperature !== undefined && (merged.temperature < 0 || merged.temperature > 2)) return "Temperature must be between 0 and 2";
      if (merged.monthlyBudgetUsd !== undefined && (!(merged.monthlyBudgetUsd >= 0) || merged.monthlyBudgetUsd > 100000)) return "Monthly budget must be between $0 and $100,000";
      if (merged.timeoutMinutes !== undefined && (!Number.isInteger(merged.timeoutMinutes) || merged.timeoutMinutes < 1 || merged.timeoutMinutes > 1440)) return "Time limit must be a whole number of minutes between 1 and 1440";
      next.roles[role] = merged;
    }
    // A local-only agent can't be given a cloud model, as its main model or its fallback
    for (const role of MODEL_ROLES) {
      const s = next.roles[role];
      if (!s.localOnly) continue;
      for (const ref of [s.model, s.fallback]) {
        const parsed = ref ? parseModelRef(ref, providers) : null;
        if (parsed && !parsed.provider.local) return `${role} is local only, so it can't use the cloud model ${ref}. Turn off "Local only" for it first.`;
      }
    }
    const cleanPrices: Record<string, ModelPrice> = {};
    for (const [ref, price] of Object.entries(next.prices)) {
      const norm = normalizeRef(ref, providers) ?? ref;
      if (!(price.input >= 0 && price.output >= 0 && price.input < 10000 && price.output < 10000)) return `Price for ${ref} must be dollars per million tokens`;
      cleanPrices[norm] = { input: Number(price.input), output: Number(price.output) };
    }
    next.prices = cleanPrices;
    for (const [alias, ref] of Object.entries(next.aliases)) {
      if (!/^[a-z0-9][a-z0-9 _.-]{0,30}$/.test(alias)) return `Alias "${alias}" should be short lowercase text`;
      if (!normalizeRef(ref, providers)) return `No provider for alias "${alias}" → ${ref}`;
    }
    this.store.setSetting("models", { ...next, monthlyBudgetUsd: next.monthlyBudgetUsd ?? null });
    return null;
  }

  /** The model an agent should use right now (falls back past its daily token limit). */
  resolve(role: ModelRole, override?: string): Resolved {
    const s = this.effective(role);
    const providers = this.providers();
    let ref = override || s.model;
    let parsed = parseModelRef(ref, providers);
    if (!override && parsed && !parsed.provider.local && s.dailyTokenLimit && this.store.tokensToday(role) >= s.dailyTokenLimit) {
      // No fallback set: the cap still holds, and the agent uses the default local model
      ref = s.fallback || `ollama/${this.defaults.model}`;
      parsed = parseModelRef(ref, providers);
    }
    if (!parsed) {
      // The provider went away (e.g. its API key was removed): use local Ollama
      ref = `ollama/${this.defaults.model}`;
      parsed = parseModelRef(ref, providers)!;
    }
    return { role, ref: `${parsed.provider.id}/${parsed.model}`, provider: parsed.provider, model: parsed.model, settings: s };
  }

  /** A local model for this role: its fallback if that is local, otherwise the default local model. */
  localFor(role: ModelRole): Resolved {
    const s = this.effective(role);
    const providers = this.providers();
    const fb = s.fallback ? parseModelRef(s.fallback, providers) : null;
    const main = parseModelRef(s.model, providers);
    // The vision agent's last resort is the local vision model, since a text model can't read pictures
    const defaultLocal =
      role === "vision" ? (this.defaults.visionModel ?? "qwen3.5:latest") : role === "audio" ? (this.defaults.audioModel ?? "gemma4:12b") : this.defaults.model;
    const pick = fb?.provider.local ? fb : main?.provider.local ? main : parseModelRef(`ollama/${defaultLocal}`, providers)!;
    return { role, ref: `${pick.provider.id}/${pick.model}`, provider: pick.provider, model: pick.model, settings: s };
  }

  /** This agent's own time limit in milliseconds, when one is set. */
  timeoutMs(role: ModelRole): number | undefined {
    const m = this.settings().roles[role]?.timeoutMinutes;
    return m ? m * 60_000 : undefined;
  }

  resolveFallback(role: ModelRole): Resolved | null {
    const s = this.effective(role);
    if (!s.fallback) return null;
    const parsed = parseModelRef(s.fallback, this.providers());
    return parsed ? { role, ref: `${parsed.provider.id}/${parsed.model}`, provider: parsed.provider, model: parsed.model, settings: s } : null;
  }
}

// --- "switch Jarvis to claude" ----------------------------------------------------------

const ROLE_NAMES: Record<string, ModelRole> = {
  jarvis: "planner",
  planner: "planner",
  lead: "planner",
  coder: "coder",
  code: "coder",
  browser: "browser",
  web: "browser",
  file: "file",
  files: "file",
  vault: "file",
  security: "security_audit",
  security_audit: "security_audit",
  auditor: "security_audit",
  vision: "vision",
  eyes: "vision",
  tools: "tools",
  toolbox: "tools",
  audio: "audio",
  transcriber: "audio",
  ears: "audio",
  router: "router",
  memory: "memory",
};

export interface SwitchCommand {
  role: ModelRole | "all";
  target: string;
}

/**
 * Recognises short commands such as "switch to claude", "switch coder to local",
 * "use openrouter/x for the browser" or "go local". Anything longer or less
 * certain returns null and is treated as a normal task.
 */
export function parseSwitchCommand(text: string): SwitchCommand | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (t.split(/\s+/).length > 8) return null;
  let m = t.match(/^go (local|cloud)$/);
  if (m) return { role: "planner", target: m[1] };
  m = t.match(/^(?:switch|set|move)(?: (?:the )?([a-z_]+))? (?:to|onto) ([\w.:\/@ -]+)$/);
  if (m) {
    const who = m[1] ? ROLE_NAMES[m[1]] ?? (m[1] === "everyone" || m[1] === "all" ? "all" : undefined) : "planner";
    if (!who) return null;
    return { role: who, target: m[2].trim() };
  }
  m = t.match(/^use ([\w.:\/@-]+)(?: for (?:the )?([a-z_]+))?$/);
  if (m) {
    const who = m[2] ? ROLE_NAMES[m[2]] ?? (m[2] === "everyone" || m[2] === "all" ? "all" : undefined) : "planner";
    if (!who) return null;
    return { role: who, target: m[1] };
  }
  return null;
}

/** "use preset fast", "switch to the local preset", "preset best quality": the preset's name, or null. */
export function parsePresetCommand(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (t.split(/\s+/).length > 8) return null;
  const m = t.match(/^(?:(?:use|switch to|apply|load|go)\s+(?:the\s+)?)?(?:preset\s+["“]?(.+?)["”]?|["“]?(.+?)["”]?\s+preset)$/);
  return m ? (m[1] ?? m[2]).trim() : null;
}

/** Turns an alias or reference into a model reference, or null if it means nothing. */
export function resolveTarget(target: string, settings: ModelSettings, providers: Provider[]): string | null {
  const alias = settings.aliases[target];
  if (alias) return normalizeRef(alias, providers);
  // Only accept explicit references here, so a typo doesn't become an Ollama model name
  if (target.includes("/") || target.includes(":")) return normalizeRef(target, providers);
  return null;
}
