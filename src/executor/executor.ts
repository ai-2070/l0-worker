import { l0, structured } from "@ai2070/l0";
import { streamText, streamObject } from "ai";
import type { CoreMessage } from "ai";
import { jsonSchema } from "ai";
import type {
  InferenceOrder,
  ModelSpec,
  JsonOutput,
  RetrySpec,
} from "../inference/index.js";
import type { TaskPayload } from "./task.js";
import { getModel } from "./providers.js";

export interface ExecutionResult {
  content: string;
  outputHash: string;
  tokenCount: number;
  inputTokens: number;
  outputTokens: number;
  modelUsed: ModelSpec;
  validatedOutput?: unknown;
}

export interface ExecutionCallbacks {
  onFirstToken?: () => void;
  onToken?: (token: string) => void;
  onL0Event?: (event: L0Event) => void;
}

/**
 * L0 lifecycle event - forwarded to L1 as-is.
 * Only `type` and `ts` are guaranteed; all other fields are event-specific.
 */
export interface L0Event {
  type: string;
  ts: number;
  [key: string]: unknown;
}

/**
 * Execute an inference order using L0 runtime.
 * L0 handles retry, fallback, guardrails, and network protection.
 */
export async function executeOrder(
  order: InferenceOrder,
  payload: TaskPayload,
  callbacks?: ExecutionCallbacks,
): Promise<ExecutionResult> {
  const { execution, output } = order;
  const primaryModel = execution.models[0];
  const messages = buildMessages(payload);

  // For JSON output, use structured()
  if (output.kind === "json") {
    return await executeStructured(
      primaryModel,
      execution,
      messages,
      output,
      callbacks,
    );
  }

  // For text/tokens, use l0() with streamText
  return await executeText(primaryModel, execution, messages, callbacks);
}

/**
 * Execute text streaming with L0 runtime.
 */
async function executeText(
  primaryModel: ModelSpec,
  execution: InferenceOrder["execution"],
  messages: CoreMessage[],
  callbacks?: ExecutionCallbacks,
): Promise<ExecutionResult> {
  const params = primaryModel.params ?? {};
  let firstTokenEmitted = false;
  let content = "";
  let tokenCount = 0;

  const result = await l0({
    stream: () =>
      streamText({
        model: getModel(primaryModel),
        messages,
        temperature: params.temperature as number | undefined,
        maxOutputTokens: params.maxTokens as number | undefined,
        topP: params.topP as number | undefined,
        frequencyPenalty: params.frequencyPenalty as number | undefined,
        presencePenalty: params.presencePenalty as number | undefined,
        stopSequences: params.stop as string[] | undefined,
      }),

    // Fallback streams
    fallbackStreams: execution.fallbacks?.map((fb) => {
      const fbParams = fb.model.params ?? {};
      return () =>
        streamText({
          model: getModel(fb.model),
          messages,
          temperature: fbParams.temperature as number | undefined,
          maxOutputTokens: fbParams.maxTokens as number | undefined,
          topP: fbParams.topP as number | undefined,
          frequencyPenalty: fbParams.frequencyPenalty as number | undefined,
          presencePenalty: fbParams.presencePenalty as number | undefined,
          stopSequences: fbParams.stop as string[] | undefined,
        });
    }),

    // Retry configuration from order
    retry: mapRetrySpec(execution.retry),

    // Lifecycle callbacks
    onStart: () => {
      if (!firstTokenEmitted) {
        firstTokenEmitted = true;
        callbacks?.onFirstToken?.();
      }
    },

    // Forward all L0 events to L1
    onEvent: (event: L0Event) => {
      callbacks?.onL0Event?.(event);
    },
  });

  // Consume stream
  for await (const event of result.stream) {
    if (event.type === "token" && event.value) {
      content += event.value;
      tokenCount++;
      callbacks?.onToken?.(event.value);
    }
  }

  return {
    content,
    outputHash: "", // Computed by caller
    tokenCount,
    inputTokens: result.state.inputTokens ?? 0,
    outputTokens: result.state.outputTokens ?? tokenCount,
    modelUsed: primaryModel,
  };
}

/**
 * Execute structured output with L0 runtime.
 */
async function executeStructured(
  primaryModel: ModelSpec,
  execution: InferenceOrder["execution"],
  messages: CoreMessage[],
  outputSpec: JsonOutput,
  callbacks?: ExecutionCallbacks,
): Promise<ExecutionResult> {
  const params = primaryModel.params ?? {};
  let firstTokenEmitted = false;

  const result = await structured({
    schema: jsonSchema(outputSpec.schema),
    stream: () =>
      streamObject({
        model: getModel(primaryModel),
        messages,
        schema: jsonSchema(outputSpec.schema),
        temperature: params.temperature as number | undefined,
        maxOutputTokens: params.maxTokens as number | undefined,
        topP: params.topP as number | undefined,
        frequencyPenalty: params.frequencyPenalty as number | undefined,
        presencePenalty: params.presencePenalty as number | undefined,
      }),

    // Retry configuration
    retry: mapRetrySpec(execution.retry),

    // Auto-correct JSON if not strict
    autoCorrect: !(outputSpec.strict ?? true),

    onStart: () => {
      if (!firstTokenEmitted) {
        firstTokenEmitted = true;
        callbacks?.onFirstToken?.();
      }
    },

    // Forward all L0 events to L1
    onEvent: (event: L0Event) => {
      callbacks?.onL0Event?.(event);
    },
  });

  const content = JSON.stringify(result.data);

  return {
    content,
    outputHash: "", // Computed by caller
    tokenCount: result.state?.tokenCount ?? 0,
    inputTokens: result.state?.inputTokens ?? 0,
    outputTokens: result.state?.outputTokens ?? 0,
    modelUsed: primaryModel,
    validatedOutput: result.data,
  };
}

/**
 * Map our RetrySpec to L0's retry config.
 */
function mapRetrySpec(spec: RetrySpec | undefined):
  | {
      attempts: number;
      maxRetries: number;
      backoff: string;
      baseDelay?: number;
      maxDelay?: number;
    }
  | undefined {
  if (!spec) return undefined;

  return {
    attempts: spec.attempts,
    maxRetries: spec.maxRetries,
    backoff: spec.backoff,
    baseDelay: spec.baseDelayMs,
    maxDelay: spec.maxDelayMs,
  };
}

/**
 * Build messages from payload.
 */
function buildMessages(payload: TaskPayload): CoreMessage[] {
  if (payload.messages) {
    return payload.messages;
  }

  if (payload.prompt) {
    return [{ role: "user", content: payload.prompt }];
  }

  throw new Error("Payload must have either prompt or messages");
}

/**
 * Output validation error.
 */
export class OutputValidationError extends Error {
  constructor(public readonly reason: string) {
    super(`Output validation failed: ${reason}`);
    this.name = "OutputValidationError";
  }
}
