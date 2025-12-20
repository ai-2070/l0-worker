import { l0 } from "@ai2070/l0";
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

export interface ExecutionOptions {
  callbacks?: ExecutionCallbacks;
  meta?: Record<string, unknown>;
  workerId?: string;
}

/**
 * Execute an inference order using L0 runtime.
 * L0 handles retry, fallback, guardrails, and network protection.
 */
export async function executeOrder(
  order: InferenceOrder,
  payload: TaskPayload,
  options?: ExecutionOptions,
): Promise<ExecutionResult> {
  const { callbacks, meta, workerId } = options ?? {};
  const { execution, output } = order;
  const primaryModel = execution.models[0];
  const messages = buildMessages(payload);

  // Build meta with workerId
  const l0Meta = { ...meta, workerId };

  // For JSON output, use structured()
  if (output.kind === "json") {
    return await executeStructured(
      primaryModel,
      execution,
      messages,
      output,
      callbacks,
      l0Meta,
    );
  }

  // For text/tokens, use l0() with streamText
  return await executeText(
    primaryModel,
    execution,
    messages,
    callbacks,
    l0Meta,
  );
}

/**
 * Execute text streaming with L0 runtime.
 */
async function executeText(
  primaryModel: ModelSpec,
  execution: InferenceOrder["execution"],
  messages: CoreMessage[],
  callbacks?: ExecutionCallbacks,
  meta?: Record<string, unknown>,
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
        maxOutputTokens: params.maxOutputTokens as number | undefined,
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
          maxOutputTokens: fbParams.maxOutputTokens as number | undefined,
          topP: fbParams.topP as number | undefined,
          frequencyPenalty: fbParams.frequencyPenalty as number | undefined,
          presencePenalty: fbParams.presencePenalty as number | undefined,
          stopSequences: fbParams.stop as string[] | undefined,
        });
    }),

    // Retry configuration from order
    retry: mapRetrySpec(execution.retry),

    // Pass through meta for L0 event context
    meta,

    // Forward all L0 events to L1
    onEvent: (event: L0Event) => {
      callbacks?.onL0Event?.(event);
    },
  });

  // Consume stream
  for await (const event of result.stream) {
    if (event.type === "token" && event.value) {
      if (!firstTokenEmitted) {
        firstTokenEmitted = true;
        callbacks?.onFirstToken?.();
      }
      content += event.value;
      tokenCount++;
      callbacks?.onToken?.(event.value);
    }
  }

  return {
    content,
    tokenCount,
    inputTokens: result.state.inputTokens ?? 0,
    outputTokens: result.state.outputTokens ?? tokenCount,
    modelUsed: primaryModel,
  };
}

/**
 * Execute structured output with L0 runtime.
 * Uses streamObject from AI SDK which handles JSON parsing/validation,
 * wrapped with L0 for retry, fallback, and reliability features.
 */
async function executeStructured(
  primaryModel: ModelSpec,
  execution: InferenceOrder["execution"],
  messages: CoreMessage[],
  outputSpec: JsonOutput,
  callbacks?: ExecutionCallbacks,
  meta?: Record<string, unknown>,
): Promise<ExecutionResult> {
  const params = primaryModel.params ?? {};
  let firstTokenEmitted = false;
  let content = "";
  let tokenCount = 0;

  // Store reference to streamObject result to access .object promise later
  let streamObjectResult: Awaited<ReturnType<typeof streamObject>> | null =
    null;

  const result = await l0({
    stream: () => {
      const res = streamObject({
        model: getModel(primaryModel),
        messages,
        schema: jsonSchema(outputSpec.schema),
        temperature: params.temperature as number | undefined,
        maxOutputTokens: params.maxOutputTokens as number | undefined,
        topP: params.topP as number | undefined,
        frequencyPenalty: params.frequencyPenalty as number | undefined,
        presencePenalty: params.presencePenalty as number | undefined,
      });
      streamObjectResult = res;
      return res;
    },

    // Fallback streams
    fallbackStreams: execution.fallbacks?.map((fb) => {
      const fbParams = fb.model.params ?? {};
      return () => {
        const res = streamObject({
          model: getModel(fb.model),
          messages,
          schema: jsonSchema(outputSpec.schema),
          temperature: fbParams.temperature as number | undefined,
          maxOutputTokens: fbParams.maxOutputTokens as number | undefined,
          topP: fbParams.topP as number | undefined,
          frequencyPenalty: fbParams.frequencyPenalty as number | undefined,
          presencePenalty: fbParams.presencePenalty as number | undefined,
        });
        streamObjectResult = res;
        return res;
      };
    }),

    // Retry configuration
    retry: mapRetrySpec(execution.retry),

    // Pass through meta for L0 event context
    meta,

    // Forward all L0 events to L1
    onEvent: (event: L0Event) => {
      callbacks?.onL0Event?.(event);
    },
  });

  // Consume stream to collect tokens
  for await (const event of result.stream) {
    if (event.type === "token" && event.value) {
      if (!firstTokenEmitted) {
        firstTokenEmitted = true;
        callbacks?.onFirstToken?.();
      }
      content += event.value;
      tokenCount++;
      callbacks?.onToken?.(event.value);
    }
  }

  // Get the validated object from streamObject result
  // streamObject already validates against the schema
  let validatedOutput: unknown;
  if (streamObjectResult) {
    try {
      validatedOutput = await streamObjectResult.object;
    } catch {
      // If object parsing fails, fall back to parsing the collected content
      validatedOutput = JSON.parse(content);
    }
  } else {
    validatedOutput = JSON.parse(content);
  }

  return {
    content: JSON.stringify(validatedOutput),
    tokenCount,
    inputTokens: result.state.inputTokens ?? 0,
    outputTokens: result.state.outputTokens ?? tokenCount,
    modelUsed: primaryModel,
    validatedOutput,
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
