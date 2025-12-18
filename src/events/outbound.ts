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
  durationMs: z.number(),
  tokenCount: z.number(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
});

export type TaskMetrics = z.infer<typeof TaskMetricsSchema>;

/**
 * WORKER_READY - Emitted when worker is able to accept work.
 */
export const WorkerReadyEventSchema = z.object({
  type: z.literal("WORKER_READY"),
  workerId: z.string(),
  protocolVersion: z.string(),
  maxConcurrency: z.number(),
  ts: z.number(),
});

/**
 * WORKER_LOAD - Current pressure, not intent.
 */
export const WorkerLoadEventSchema = z.object({
  type: z.literal("WORKER_LOAD"),
  workerId: z.string(),
  inflightTasks: z.number(),
  queueDepth: z.number(), // Always 0 - no internal queue
  cpuPressure: z.number(),
  memoryPressure: z.number(),
  gpuPressure: z.number().optional(),
  ts: z.number(),
});

/**
 * TASK_ACCEPTED - Commit point for execution.
 */
export const TaskAcceptedEventSchema = z.object({
  type: z.literal("TASK_ACCEPTED"),
  taskId: z.string(),
  workerId: z.string(),
  ts: z.number(),
});

/**
 * TASK_PROGRESS - Milestone-based progress.
 */
export const TaskProgressEventSchema = z.object({
  type: z.literal("TASK_PROGRESS"),
  taskId: z.string(),
  stage: z.enum([
    ProgressStage.FIRST_TOKEN,
    ProgressStage.STREAMING,
    ProgressStage.TOOL_INVOKED,
    ProgressStage.CHECKPOINT_WRITTEN,
  ]),
  ts: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * TASK_COMPLETED - Terminal success state.
 */
export const TaskCompletedEventSchema = z.object({
  type: z.literal("TASK_COMPLETED"),
  taskId: z.string(),
  workerId: z.string(),
  finalMetrics: TaskMetricsSchema,
  outputHash: z.string(),
  output: z.string(),
  ts: z.number(),
});

/**
 * TASK_FAILED - Terminal failure state.
 */
export const TaskFailedEventSchema = z.object({
  type: z.literal("TASK_FAILED"),
  taskId: z.string(),
  workerId: z.string(),
  failureClass: z.enum([
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
  ts: z.number(),
});

/**
 * WORKER_DRAINING - Signals graceful shutdown.
 */
export const WorkerDrainingEventSchema = z.object({
  type: z.literal("WORKER_DRAINING"),
  workerId: z.string(),
  reason: z.string(),
  ts: z.number(),
});

/**
 * WORKER_OFFLINE - Final event.
 */
export const WorkerOfflineEventSchema = z.object({
  type: z.literal("WORKER_OFFLINE"),
  workerId: z.string(),
  ts: z.number(),
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
