import { z } from "zod";

/**
 * Task payload schema - the actual input to the LLM.
 * With InferenceOrder, payload is just the prompt/messages.
 * Model selection and params come from order.execution.
 */
export const TaskPayloadSchema = z
  .object({
    prompt: z.string().optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string(),
        }),
      )
      .optional(),
  })
  .refine(
    (data) => data.prompt || (data.messages && data.messages.length > 0),
    {
      message: "Payload must have either prompt or messages",
    },
  );

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
  return TaskPayloadSchema.parse(input);
}
