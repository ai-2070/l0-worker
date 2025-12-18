import { z } from "zod";

/**
 * Inference Order Contract
 *
 * Defines what is to be executed and what shape the result must have.
 * Eliminates ambiguity at runtime by forcing intent to be declared upfront.
 *
 * Inference without an explicit output contract is invalid.
 * No implicit defaults. No provider guessing. No post-hoc parsing.
 */

// -----------------------------------------------------------------------------
// Model Spec
// -----------------------------------------------------------------------------

export const ModelSpecSchema = z.object({
  provider: z.string(), // "openai" | "anthropic" | "local" | custom
  model: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type ModelSpec = z.infer<typeof ModelSpecSchema>;

// -----------------------------------------------------------------------------
// Parallel Spec
// -----------------------------------------------------------------------------

export const ParallelSpecSchema = z.object({
  mode: z.enum(["race", "fanout"]),
  max: z.number().positive().optional(),
});

export type ParallelSpec = z.infer<typeof ParallelSpecSchema>;

// -----------------------------------------------------------------------------
// Retry Spec
// -----------------------------------------------------------------------------

export const RetrySpecSchema = z.object({
  attempts: z.number().positive(), // LLM-level errors only
  maxRetries: z.number().positive(), // Total retries (LLM + network)
  backoff: z.enum(["fixed", "linear", "exponential", "fixed-jitter", "full-jitter"]),
  baseDelayMs: z.number().positive().optional(),
  maxDelayMs: z.number().positive().optional(),
});

export type RetrySpec = z.infer<typeof RetrySpecSchema>;

// -----------------------------------------------------------------------------
// Fallback Spec
// -----------------------------------------------------------------------------

export const FallbackSpecSchema = z.object({
  when: z.enum(["error", "timeout", "output_violation"]),
  model: ModelSpecSchema,
});

export type FallbackSpec = z.infer<typeof FallbackSpecSchema>;

// -----------------------------------------------------------------------------
// Tool Spec
// -----------------------------------------------------------------------------

export const JsonSchemaSchema = z.record(z.string(), z.unknown());

export const ToolSpecSchema = z.object({
  name: z.string(),
  schema: JsonSchemaSchema,
});

export type ToolSpec = z.infer<typeof ToolSpecSchema>;

// -----------------------------------------------------------------------------
// Execution Spec
// -----------------------------------------------------------------------------

export const ExecutionSpecSchema = z.object({
  models: z.array(ModelSpecSchema).min(1), // Ordered preference list
  parallel: ParallelSpecSchema.optional(),
  retry: RetrySpecSchema.optional(),
  fallbacks: z.array(FallbackSpecSchema).optional(),
  tools: z.array(ToolSpecSchema).optional(),
});

export type ExecutionSpec = z.infer<typeof ExecutionSpecSchema>;

// -----------------------------------------------------------------------------
// Output Spec (REQUIRED)
// -----------------------------------------------------------------------------

export const TextOutputSchema = z.object({
  kind: z.literal("text"),
});

export const TokenOutputSchema = z.object({
  kind: z.literal("tokens"),
});

export const JsonOutputSchema = z.object({
  kind: z.literal("json"),
  schema: JsonSchemaSchema,
  strict: z.boolean().default(true),
});

export const OutputSpecSchema = z.discriminatedUnion("kind", [
  TextOutputSchema,
  TokenOutputSchema,
  JsonOutputSchema,
]);

export type TextOutput = z.infer<typeof TextOutputSchema>;
export type TokenOutput = z.infer<typeof TokenOutputSchema>;
export type JsonOutput = z.infer<typeof JsonOutputSchema>;
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

// -----------------------------------------------------------------------------
// Inference Order (Top-Level)
// -----------------------------------------------------------------------------

export const InferenceOrderSchema = z.object({
  execution: ExecutionSpecSchema,
  output: OutputSpecSchema,
});

export type InferenceOrder = z.infer<typeof InferenceOrderSchema>;
