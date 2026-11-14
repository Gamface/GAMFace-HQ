import { z } from "zod";

// Shared by the harness (src/ui.ts) and the Mission Control UI (ui/), so this
// file is the single source of truth for task and event shapes.

export const AgentTargetSchema = z.enum(["planner", "browser", "coder", "file", "security_audit"]);

export const AgentStatusSchema = z.enum([
  "idle",
  "queued",
  "thinking",
  "streaming",
  "executing_tool",
  "writing_diff",
  "complete",
  "canceled",
  "error",
]);

// Where a task came from; voice tasks get spoken-style answers and are read aloud
export const TaskSourceSchema = z.enum(["ui", "voice", "api", "eval"]);

export const AgentTaskSchema = z.object({
  id: z.string().uuid().optional(),
  prompt: z.string().trim().min(1).max(20000),
  targetAgent: AgentTargetSchema.default("planner"),
  source: TaskSourceSchema.default("api"),
  // Ollama model for this task only (evals compare models); defaults to OLLAMA_MODEL
  model: z.string().regex(/^[\w.:\/-]{1,100}$/).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
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
  source: TaskSourceSchema,
  model: z.string(),
  status: AgentStatusSchema,
  createdAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  error: z.string().optional(),
});

export type AgentTarget = z.infer<typeof AgentTargetSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type TaskSource = z.infer<typeof TaskSourceSchema>;
export type AgentTask = z.infer<typeof AgentTaskSchema>;
export type AgentStreamPayload = z.infer<typeof AgentStreamPayloadSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TERMINAL_STATUSES: readonly AgentStatus[] = ["complete", "canceled", "error"];
