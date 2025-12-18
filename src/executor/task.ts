import { z } from "zod";

/**
 * Task payload schema - the actual input to the LLM.
 * With InferenceOrder, payload is just the prompt/messages.
 * Model selection and params come from order.execution.
 */
export const TaskPayloadSchema = z.object({
  prompt: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    )
    .optional(),
});

export type TaskPayload = z.infer<typeof TaskPayloadSchema>;

/**
 * Constraints for task execution.
 */
export interface TaskConstraints {
  timeout_ms?: number;
  memory_cap_mb?: number;
  determinism_required?: boolean;
}

/**
 * Parse and validate task payload from unknown input.
 */
export function parseTaskPayload(input: unknown): TaskPayload {
  const parsed = TaskPayloadSchema.parse(input);

  // Must have either prompt or messages
  if (!parsed.prompt && (!parsed.messages || parsed.messages.length === 0)) {
    throw new Error("Payload must have either prompt or messages");
  }

  return parsed;
}
