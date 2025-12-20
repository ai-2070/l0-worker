import { z } from "zod";
import { InferenceOrderSchema } from "../inference/index.js";

/**
 * Ephemeral auth envelope - single-invocation trust context.
 * Token is validated once, never stored, never reused.
 */
export const AuthEnvelopeSchema = z.object({
  token: z.string().min(32),
  issued_at: z.number(),
  ttl: z.number().positive(),
});

export type AuthEnvelope = z.infer<typeof AuthEnvelopeSchema>;

/**
 * TASK_SUBMIT - The only event that can create work.
 * Proposes a unit of execution; does not guarantee acceptance.
 */
export const TaskSubmitSchema = z.object({
  type: z.literal("TASK_SUBMIT"),
  auth: AuthEnvelopeSchema,
  task_id: z.string(),
  order: InferenceOrderSchema,
  payload: z.unknown(),
  constraints: z
    .object({
      timeout_ms: z.number().optional(),
      memory_cap_mb: z.number().optional(),
      determinism_required: z.boolean().optional(),
    })
    .optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  input_hash: z.string(),
  submission_ts: z.number(),
});

/**
 * WORKER_DRAIN_REQUEST - Graceful shutdown coordination.
 */
export const WorkerDrainRequestSchema = z.object({
  type: z.literal("WORKER_DRAIN_REQUEST"),
  worker_id: z.string(),
  reason: z.string(),
  deadline_ts: z.number(),
});

/**
 * TASK_REPLAY_REQUEST - Request deterministic re-emission of recorded events.
 * Does NOT re-execute - only replays already-emitted facts.
 */
export const TaskReplayRequestSchema = z.object({
  type: z.literal("TASK_REPLAY_REQUEST"),
  auth: AuthEnvelopeSchema,
  task_id: z.string(),
  input_hash: z.string(),
  expected_output_hash: z.string().optional(),
  reason: z.string(),
  replay_ts: z.number(),
});

/**
 * WORKER_CONFIG_UPDATE - Hot reconfiguration without redeploy.
 * Auth is optional - localhost requests don't require auth.
 */
export const WorkerConfigUpdateSchema = z.object({
  type: z.literal("WORKER_CONFIG_UPDATE"),
  auth: AuthEnvelopeSchema.optional(),
  worker_id: z.string(),
  max_concurrency: z.number().optional(),
  resource_caps: z.record(z.string(), z.number()).optional(),
  feature_flags: z.record(z.string(), z.boolean()).optional(),
  effective_ts: z.number(),
});

/**
 * EXECUTION_ABORT - Hard stop (optional, v2).
 */
export const ExecutionAbortSchema = z.object({
  type: z.literal("EXECUTION_ABORT"),
  task_id: z.string(),
  reason: z.string(),
  force: z.boolean(),
});

/**
 * Union of all inbound events from L1.
 */
export const InboundEventSchema = z.discriminatedUnion("type", [
  TaskSubmitSchema,
  WorkerDrainRequestSchema,
  TaskReplayRequestSchema,
  WorkerConfigUpdateSchema,
  ExecutionAbortSchema,
]);

export type TaskSubmit = z.infer<typeof TaskSubmitSchema>;
export type WorkerDrainRequest = z.infer<typeof WorkerDrainRequestSchema>;
export type TaskReplayRequest = z.infer<typeof TaskReplayRequestSchema>;
export type WorkerConfigUpdate = z.infer<typeof WorkerConfigUpdateSchema>;
export type ExecutionAbort = z.infer<typeof ExecutionAbortSchema>;
export type InboundEvent = z.infer<typeof InboundEventSchema>;
