import { z } from "zod";

// Shared by the harness (src/ui.ts) and the Mission Control UI (ui/), so this
// file is the single source of truth for task and event shapes.

export const AgentTargetSchema = z.enum(["planner", "browser", "coder", "file", "security_audit", "vision", "tools"]);
// An attached audio clip (WAV), by its upload id
export const ProfileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Profile names are lowercase letters, numbers and dashes");
// A project, by id (see hq/projects.ts); null or missing means General
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,30}-[a-f0-9]{4}$/;
export const ProjectIdSchema = z.string().regex(PROJECT_ID);
export const DocIdSchema = z.string().regex(/^[a-f0-9]{64}\.pdf$/);
export const AudioIdSchema = z.string().regex(/^[a-f0-9]{64}\.wav$/);
// What a client may ask for: a specific agent, or "auto" to let the router pick
export const RequestedAgentSchema = z.enum(["auto", "planner", "browser", "coder", "file", "security_audit", "vision", "tools"]);
// An attached picture, by its upload id (see hq/uploads.ts)
export const ImageIdSchema = z.string().regex(/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/);

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
  // The first run writes a plan and stops; you mark it up in the Inbox and approve it before the work runs
  planFirst: z.boolean().default(false),
  // "backlog" parks the card; "ready" queues it
  column: z.enum(["backlog", "ready"]).default("ready"),
  // Read-only run: no typing or form submits, links only on allowedSites, no notes or memories saved
  readOnly: z.boolean().default(false),
  allowedSites: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/)).max(10).default([]),
  // Routine runs only: where the result is sent (default: the dashboard)
  deliverTo: DeliverySchema.optional(),
  // Browser profile to browse with (its sign-ins); the default profile when unset
  profile: ProfileNameSchema.optional(),
  // The project the card belongs to; General when missing
  project: ProjectIdSchema.nullable().optional(),
  // The Coder and File agents may create, change and delete files in the project's workspace (every change can be undone)
  workspace: z.boolean().default(false),
  // Pictures for the vision agent to look at
  images: z.array(ImageIdSchema).max(6).default([]),
  // Audio clips, transcribed before the agent starts
  audio: z.array(AudioIdSchema).max(4).default([]),
  // Attached PDFs, by upload id
  documents: z.array(DocIdSchema).max(4).default([]),
});

/** A routine: a request that a schedule turns into a read-only card. */
export const RoutineInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(4000),
  // Plain words ("weekdays at 7:30am", "every 2 hours") or five cron fields
  schedule: z.string().trim().min(1).max(100),
  // IANA time zone the schedule is in, e.g. America/New_York (the dashboard sends the browser's)
  timezone: z.string().trim().min(1).max(64).optional(),
  targetAgent: RequestedAgentSchema.default("auto"),
  deliverTo: DeliverySchema.default("dashboard"),
  allowedSites: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/)).max(10).default([]),
  enabled: z.boolean().default(true),
  // When the PC was off at run time: run once on start-up (true) or wait for the next time (false)
  catchUp: z.boolean().default(false),
  // Runs may type, submit and click, each only after the user approves it; otherwise read-only
  mayAct: z.boolean().default(false),
  // Browser profile its runs sign in with (when it may act); the default when unset
  profile: ProfileNameSchema.nullable().optional(),
  // The project its cards go in; General when missing
  project: ProjectIdSchema.nullable().optional(),
});
export const RoutinePatchSchema = RoutineInputSchema.partial();

export const RoutineSchema = RoutineInputSchema.extend({
  id: z.string(),
  timezone: z.string(),
  cron: z.string(),
  label: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nextRunAt: z.number().optional(),
  lastRunAt: z.number().optional(),
  lastTaskId: z.string().optional(),
  lastStatus: z.string().optional(),
  // Why the last scheduled run didn't start (still running, queue full…)
  lastSkip: z.string().optional(),
  runs: z.number().default(0),
});

/** A reply to a finished card: the same agent continues the conversation. */
export const TaskReplySchema = z.object({
  message: z.string().trim().min(1).max(20000),
  images: z.array(ImageIdSchema).max(6).default([]),
  audio: z.array(AudioIdSchema).max(4).default([]),
  // Attached PDFs, by upload id
  documents: z.array(DocIdSchema).max(4).default([]),
  // "same" keeps the agent that answered; "auto" routes the reply again
  targetAgent: z.union([z.literal("same"), RequestedAgentSchema]).default("same"),
});

/** One finished turn of a card's conversation. */
export const ThreadTurnSchema = z.object({
  role: z.enum(["user", "agent"]),
  text: z.string(),
  agent: AgentTargetSchema.optional(),
  // The turn came from (or was answered with) private material
  private: z.boolean().optional(),
  images: z.array(z.string()).optional(),
  audio: z.array(z.string()).optional(),
  documents: z.array(z.string()).optional(),
  // What the agent learned from attachments (transcripts, picture descriptions); private
  notes: z.string().optional(),
  at: z.number(),
});

export const TaskPatchSchema = z.object({
  title: z.string().trim().max(200).optional(),
  prompt: z.string().trim().min(1).max(20000).optional(),
  targetAgent: RequestedAgentSchema.optional(),
  priority: PrioritySchema.optional(),
  dependsOn: z.array(z.string().uuid()).max(10).optional(),
  needsReview: z.boolean().optional(),
  planFirst: z.boolean().optional(),
  // Move between backlog and ready, or reorder within a column
  column: z.enum(["backlog", "ready"]).optional(),
  position: z.number().optional(),
  readOnly: z.boolean().optional(),
  profile: ProfileNameSchema.nullable().optional(),
  // Move the card to another project (null: General)
  project: ProjectIdSchema.nullable().optional(),
  workspace: z.boolean().optional(),
  allowedSites: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/)).max(10).optional(),
  images: z.array(ImageIdSchema).max(6).optional(),
  audio: z.array(AudioIdSchema).max(4).optional(),
  documents: z.array(DocIdSchema).max(4).optional(),
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

const PlanAnnotationSchema = z.object({
  blockId: z.string().max(20),
  quote: z.string().max(2000),
  kind: z.enum(["comment", "delete", "replace"]),
  text: z.string().max(2000).optional(),
});

export const PlanStateSchema = z.object({
  status: z.enum(["awaiting", "revising", "approved"]),
  version: z.number(),
  text: z.string(),
  at: z.number(),
  lastReview: z
    .object({ decision: z.enum(["approve", "revise"]), annotations: z.array(PlanAnnotationSchema), note: z.string().optional(), at: z.number() })
    .optional(),
});

/** Your review of a plan: the markup, and whether it runs or goes back for another version. */
export const PlanReviewSchema = z.object({
  decision: z.enum(["approve", "revise"]),
  annotations: z.array(PlanAnnotationSchema).max(60).default([]),
  note: z.string().trim().max(4000).optional(),
  // The version you marked up; a newer one means your markup is stale
  version: z.number().int().optional(),
});

/** Your answer to an agent's question in the Inbox. */
export const QuestionAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(1000),
  note: z.string().trim().max(1000).optional(),
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
  // Plan first: the card's plan and where its review stands
  planFirst: z.boolean().optional(),
  plan: PlanStateSchema.optional(),
  parentId: z.string().optional(),
  position: z.number().optional(),
  // Set when a restart cut the run short; the card waits for Retry
  interrupted: z.boolean().optional(),
  attempts: z.number().optional(),
  readOnly: z.boolean().optional(),
  allowedSites: z.array(z.string()).optional(),
  deliverTo: DeliverySchema.optional(),
  // Browser profile (sign-ins) the card's browsing uses
  profile: z.string().optional(),
  project: z.string().optional(),
  workspace: z.boolean().optional(),
  // Change sets (file edits) this card made, newest last
  changes: z.array(z.string()).optional(),
  images: z.array(z.string()).optional(),
  audio: z.array(z.string()).optional(),
  documents: z.array(z.string()).optional(),
  // True when the answer was produced from private material (vault notes, memories, pictures)
  usedPrivate: z.boolean().optional(),
  // Earlier turns, when the card has been replied to; the current round is reply ?? prompt
  thread: z.array(ThreadTurnSchema).optional(),
  // The user's latest reply, which the current run answers
  reply: z.string().optional(),
  // How many times the card has been replied to (lists send this instead of the thread)
  replies: z.number().optional(),
  // The routine that created this card
  routineId: z.string().optional(),
  // The approval request this card is waiting on
  awaitingApproval: z.string().optional(),
  // PDF reports made from the card's answer
  files: z.array(z.object({ name: z.string(), bytes: z.number(), pictures: z.number().optional(), at: z.number() })).optional(),
});

export type AgentTarget = z.infer<typeof AgentTargetSchema>;
export type RequestedAgent = z.infer<typeof RequestedAgentSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type TaskSource = z.infer<typeof TaskSourceSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type BoardColumn = z.infer<typeof BoardColumnSchema>;
export type AgentTask = z.infer<typeof AgentTaskSchema>;
export type TaskPatch = z.infer<typeof TaskPatchSchema>;
export type TaskReply = z.infer<typeof TaskReplySchema>;
export type RoutineInput = z.infer<typeof RoutineInputSchema>;
export type Routine = z.infer<typeof RoutineSchema>;
export type ThreadTurn = z.infer<typeof ThreadTurnSchema>;
export type AgentStreamPayload = z.infer<typeof AgentStreamPayloadSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TERMINAL_STATUSES: readonly AgentStatus[] = ["complete", "canceled", "error"];

export function boardColumn(t: Pick<TaskSummary, "status" | "needsReview" | "acceptedAt" | "plan">): BoardColumn {
  switch (t.status) {
    case "backlog":
    case "idle":
      return "backlog";
    case "queued":
      return "ready";
    case "complete":
      // A plan waiting for your markup is in review too
      return t.plan?.status === "awaiting" || (t.needsReview && !t.acceptedAt) ? "review" : "done";
    case "canceled":
    case "error":
      return "failed";
    default:
      return "running";
  }
}
