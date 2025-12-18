import { z } from "zod";

/**
 * Failure classes - enumerated, not free-text.
 */
export const FailureClass = {
  TIMEOUT: "timeout",
  RATE_LIMITED: "rate_limited",
  CONTEXT_LENGTH_EXCEEDED: "context_length_exceeded",
  INVALID_INPUT: "invalid_input",
  MODEL_ERROR: "model_error",
  NETWORK_ERROR: "network_error",
  GUARDRAIL_VIOLATION: "guardrail_violation",
  DETERMINISM_VIOLATION: "determinism_violation",
  ABORTED: "aborted",
  UNKNOWN: "unknown",
} as const;

export type FailureClass = (typeof FailureClass)[keyof typeof FailureClass];

/**
 * Progress stages - milestone-based, not percentages.
 */
export const ProgressStage = {
  FIRST_TOKEN: "first_token",
  STREAMING: "streaming",
  TOOL_INVOKED: "tool_invoked",
  CHECKPOINT_WRITTEN: "checkpoint_written",
} as const;

export type ProgressStage = (typeof ProgressStage)[keyof typeof ProgressStage];

/**
 * Task metrics included in TASK_COMPLETED.
 */
export const TaskMetricsSchema = z.object({
  duration_ms: z.number(),
  token_count: z.number(),
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
});

export type TaskMetrics = z.infer<typeof TaskMetricsSchema>;

/**
 * WORKER_READY - Emitted when worker is able to accept work.
 */
export const WorkerReadyEventSchema = z.object({
  type: z.literal("WORKER_READY"),
  worker_id: z.string(),
  protocol_version: z.string(),
  max_concurrency: z.number(),
  timestamp: z.number(),
});

/**
 * WORKER_LOAD - Current pressure, not intent.
 */
export const WorkerLoadEventSchema = z.object({
  type: z.literal("WORKER_LOAD"),
  worker_id: z.string(),
  inflight_tasks: z.number(),
  queue_depth: z.number(), // Always 0 - no internal queue
  cpu_pressure: z.number(),
  memory_pressure: z.number(),
  gpu_pressure: z.number().optional(),
  timestamp: z.number(),
});

/**
 * TASK_ACCEPTED - Commit point for execution.
 */
export const TaskAcceptedEventSchema = z.object({
  type: z.literal("TASK_ACCEPTED"),
  task_id: z.string(),
  worker_id: z.string(),
  timestamp: z.number(),
});

/**
 * TASK_PROGRESS - Milestone-based progress.
 */
export const TaskProgressEventSchema = z.object({
  type: z.literal("TASK_PROGRESS"),
  task_id: z.string(),
  stage: z.enum([
    ProgressStage.FIRST_TOKEN,
    ProgressStage.STREAMING,
    ProgressStage.TOOL_INVOKED,
    ProgressStage.CHECKPOINT_WRITTEN,
  ]),
  timestamp: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * TASK_COMPLETED - Terminal success state.
 */
export const TaskCompletedEventSchema = z.object({
  type: z.literal("TASK_COMPLETED"),
  task_id: z.string(),
  worker_id: z.string(),
  final_metrics: TaskMetricsSchema,
  output_hash: z.string(),
  output: z.string(),
  timestamp: z.number(),
});

/**
 * TASK_FAILED - Terminal failure state.
 */
export const TaskFailedEventSchema = z.object({
  type: z.literal("TASK_FAILED"),
  task_id: z.string(),
  worker_id: z.string(),
  failure_class: z.enum([
    FailureClass.TIMEOUT,
    FailureClass.RATE_LIMITED,
    FailureClass.CONTEXT_LENGTH_EXCEEDED,
    FailureClass.INVALID_INPUT,
    FailureClass.MODEL_ERROR,
    FailureClass.NETWORK_ERROR,
    FailureClass.GUARDRAIL_VIOLATION,
    FailureClass.DETERMINISM_VIOLATION,
    FailureClass.ABORTED,
    FailureClass.UNKNOWN,
  ]),
  retryable: z.boolean(),
  message: z.string().optional(),
  timestamp: z.number(),
});

/**
 * WORKER_DRAINING - Signals graceful shutdown.
 */
export const WorkerDrainingEventSchema = z.object({
  type: z.literal("WORKER_DRAINING"),
  worker_id: z.string(),
  reason: z.string(),
  timestamp: z.number(),
});

/**
 * WORKER_OFFLINE - Final event.
 */
export const WorkerOfflineEventSchema = z.object({
  type: z.literal("WORKER_OFFLINE"),
  worker_id: z.string(),
  timestamp: z.number(),
});

/**
 * Union of all outbound events to L1.
 */
export const OutboundEventSchema = z.discriminatedUnion("type", [
  WorkerReadyEventSchema,
  WorkerLoadEventSchema,
  TaskAcceptedEventSchema,
  TaskProgressEventSchema,
  TaskCompletedEventSchema,
  TaskFailedEventSchema,
  WorkerDrainingEventSchema,
  WorkerOfflineEventSchema,
]);

export type WorkerReadyEvent = z.infer<typeof WorkerReadyEventSchema>;
export type WorkerLoadEvent = z.infer<typeof WorkerLoadEventSchema>;
export type TaskAcceptedEvent = z.infer<typeof TaskAcceptedEventSchema>;
export type TaskProgressEvent = z.infer<typeof TaskProgressEventSchema>;
export type TaskCompletedEvent = z.infer<typeof TaskCompletedEventSchema>;
export type TaskFailedEvent = z.infer<typeof TaskFailedEventSchema>;
export type WorkerDrainingEvent = z.infer<typeof WorkerDrainingEventSchema>;
export type WorkerOfflineEvent = z.infer<typeof WorkerOfflineEventSchema>;
export type OutboundEvent = z.infer<typeof OutboundEventSchema>;
