import type { Provider } from "./providers";
import { builtinProviders, normalizeRef, parseModelRef } from "./providers";
import type { TaskStore } from "./taskstore";

// Which model each agent uses. Settings live in the database (edited on the
// Team page or with "switch <agent> to <model>"), with defaults from .env.

export const MODEL_ROLES = ["planner", "coder", "browser", "file", "security_audit", "vision", "router", "memory", "audio"] as const;
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
}

const ID_RE = /^[a-z][a-z0-9_-]{1,30}$/;

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
    return { roles, aliases: { local: main }, customProviders: [], prices: {} };
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
      if (["ollama", "lmstudio", "openai", "openrouter", "anthropic", "gemini"].includes(c.id)) return `"${c.id}" is a built-in provider`;
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
    const s = this.settings().roles[role];
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
    const s = this.settings().roles[role];
    const providers = this.providers();
    const fb = s.fallback ? parseModelRef(s.fallback, providers) : null;
    const main = parseModelRef(s.model, providers);
    // The vision agent's last resort is the local vision model, since a text model can't read pictures
    const defaultLocal =
      role === "vision" ? (this.defaults.visionModel ?? "qwen3.5:latest") : role === "audio" ? (this.defaults.audioModel ?? "gemma4:12b") : this.defaults.model;
    const pick = fb?.provider.local ? fb : main?.provider.local ? main : parseModelRef(`ollama/${defaultLocal}`, providers)!;
    return { role, ref: `${pick.provider.id}/${pick.model}`, provider: pick.provider, model: pick.model, settings: s };
  }

  resolveFallback(role: ModelRole): Resolved | null {
    const s = this.settings().roles[role];
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

/** Turns an alias or reference into a model reference, or null if it means nothing. */
export function resolveTarget(target: string, settings: ModelSettings, providers: Provider[]): string | null {
  const alias = settings.aliases[target];
  if (alias) return normalizeRef(alias, providers);
  // Only accept explicit references here, so a typo doesn't become an Ollama model name
  if (target.includes("/") || target.includes(":")) return normalizeRef(target, providers);
  return null;
}
