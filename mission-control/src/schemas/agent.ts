import { z } from "zod";

// Shared by the harness (src/ui.ts) and the Mission Control UI (ui/), so this
// file is the single source of truth for task and event shapes.

export const AgentTargetSchema = z.enum(["planner", "browser", "coder", "file", "security_audit"]);
// What a client may ask for: a specific agent, or "auto" to let the router pick
export const RequestedAgentSchema = z.enum(["auto", "planner", "browser", "coder", "file", "security_audit"]);

export const AgentStatusSchema = z.enum([
  "idle",
  // On the board but not queued yet
  "backlog",
  "queued",
  "routing",
  "thinking",
  "delegating",
  "streaming",
  "executing_tool",
  "writing_diff",
  "complete",
  "canceled",
  "error",
]);

// Where a task came from; voice tasks get spoken-style answers and are read aloud
// "routine" cards are created by a schedule and always run read-only (see hq/routine.ts)
export const TaskSourceSchema = z.enum(["ui", "voice", "api", "eval", "telegram", "routine"]);

// Where a routine run's result goes
export const DeliverySchema = z.enum(["dashboard", "telegram", "obsidian"]);

export const PrioritySchema = z.enum(["low", "normal", "high"]);

// Kanban columns. A task's column is worked out from its status (see boardColumn).
export const BoardColumnSchema = z.enum(["backlog", "ready", "running", "review", "done", "failed"]);

// A model reference: "provider/model", e.g. "ollama/qwen3:14b" or
// "openrouter/anthropic/claude-sonnet-4.5". A bare name like "qwen3:14b" means Ollama.
export const ModelRefSchema = z.string().regex(/^[\w.:\/@-]{1,120}$/);

export const AgentTaskSchema = z.object({
  id: z.string().uuid().optional(),
  prompt: z.string().trim().min(1).max(20000),
  targetAgent: RequestedAgentSchema.default("planner"),
  source: TaskSourceSchema.default("api"),
  // Model for this task only (evals compare models); otherwise the agent's own model
  model: ModelRefSchema.optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  // Board fields
  title: z.string().trim().max(200).optional(),
  priority: PrioritySchema.default("normal"),
  // Card ids that must be complete before this one runs
  dependsOn: z.array(z.string().uuid()).max(10).default([]),
  // Finished cards wait in the Review column until accepted
  needsReview: z.boolean().default(false),
  // "backlog" parks the card; "ready" queues it
  column: z.enum(["backlog", "ready"]).default("ready"),
  // Read-only run: no typing or form submits, links only on allowedSites, no notes or memories saved
  readOnly: z.boolean().default(false),
  allowedSites: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/)).max(10).default([]),
  // Routine runs only: where the result is sent (default: the dashboard)
  deliverTo: DeliverySchema.optional(),
});

export const TaskPatchSchema = z.object({
  title: z.string().trim().max(200).optional(),
  prompt: z.string().trim().min(1).max(20000).optional(),
  targetAgent: RequestedAgentSchema.optional(),
  priority: PrioritySchema.optional(),
  dependsOn: z.array(z.string().uuid()).max(10).optional(),
  needsReview: z.boolean().optional(),
  // Move between backlog and ready, or reorder within a column
  column: z.enum(["backlog", "ready"]).optional(),
  position: z.number().optional(),
  readOnly: z.boolean().optional(),
  allowedSites: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/)).max(10).optional(),
});

export const AgentStreamPayloadSchema = z.object({
  eventId: z.number().int(),
  taskId: z.string(),
  timestamp: z.number(),
  status: AgentStatusSchema,
  activeSubAgent: z.string(),
  logChunk: z.string(),
  diff: z.string().optional(),
  source: TaskSourceSchema.optional(),
});

export const TaskSummarySchema = z.object({
  id: z.string(),
  prompt: z.string(),
  targetAgent: AgentTargetSchema,
  // Set when the router picked targetAgent
  routedBy: z.enum(["user", "router", "keywords"]).optional(),
  source: TaskSourceSchema,
  // The model that ran (or will run) the task, as a model reference
  model: z.string(),
  // Agents that worked on the task through delegation, in order
  delegatedTo: z.array(AgentTargetSchema).optional(),
  status: AgentStatusSchema,
  createdAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  error: z.string().optional(),
  // Board fields
  title: z.string().optional(),
  priority: PrioritySchema.optional(),
  dependsOn: z.array(z.string()).optional(),
  needsReview: z.boolean().optional(),
  acceptedAt: z.number().optional(),
  parentId: z.string().optional(),
  position: z.number().optional(),
  // Set when a restart cut the run short; the card waits for Retry
  interrupted: z.boolean().optional(),
  attempts: z.number().optional(),
  readOnly: z.boolean().optional(),
  allowedSites: z.array(z.string()).optional(),
  deliverTo: DeliverySchema.optional(),
  // True when the answer was produced from private material (vault notes, memories)
  usedPrivate: z.boolean().optional(),
});

export type AgentTarget = z.infer<typeof AgentTargetSchema>;
export type RequestedAgent = z.infer<typeof RequestedAgentSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type TaskSource = z.infer<typeof TaskSourceSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type BoardColumn = z.infer<typeof BoardColumnSchema>;
export type AgentTask = z.infer<typeof AgentTaskSchema>;
export type TaskPatch = z.infer<typeof TaskPatchSchema>;
export type AgentStreamPayload = z.infer<typeof AgentStreamPayloadSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TERMINAL_STATUSES: readonly AgentStatus[] = ["complete", "canceled", "error"];

export function boardColumn(t: Pick<TaskSummary, "status" | "needsReview" | "acceptedAt">): BoardColumn {
  switch (t.status) {
    case "backlog":
    case "idle":
      return "backlog";
    case "queued":
      return "ready";
    case "complete":
      return t.needsReview && !t.acceptedAt ? "review" : "done";
    case "canceled":
    case "error":
      return "failed";
    default:
      return "running";
  }
}
