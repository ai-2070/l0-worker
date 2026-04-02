import {
  l0,
  race,
  parallel,
  minimalGuardrails,
  recommendedGuardrails,
  strictGuardrails,
  jsonOnlyGuardrails,
  markdownOnlyGuardrails,
  latexOnlyGuardrails,
} from "@ai2070/l0";
import type { GuardrailRule, L0Options } from "@ai2070/l0";
import { streamText, streamObject, tool as aiTool } from "ai";
import type { ModelMessage } from "ai";
import { jsonSchema } from "ai";
import type {
  InferenceOrder,
  ModelSpec,
  JsonOutput,
  RetrySpec,
  GuardrailSpec,
} from "../inference/index.js";
import { GuardrailPreset } from "../inference/index.js";
import type { TaskPayload } from "./task.js";
import { getModel } from "./providers.js";

export interface ExecutionResult {
  content: string;
  tokenCount: number;
  inputTokens: number;
  outputTokens: number;
  modelUsed: ModelSpec;
  validatedOutput?: unknown;
  toolCalls?: Array<{ name: string; args: unknown }>;
  resumed?: boolean;
}

export interface ExecutionCallbacks {
  onFirstToken?: () => void;
  onToken?: (token: string) => void;
  onL0Event?: (event: L0Event) => void;
  onToolCall?: (name: string, args: unknown) => void;
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
  signal?: AbortSignal;
}

/**
 * Execute an inference order using L0 runtime.
 * L0 handles retry, fallback, guardrails, timeouts, and network protection.
 */
export async function executeOrder(
  order: InferenceOrder,
  payload: TaskPayload,
  options?: ExecutionOptions,
): Promise<ExecutionResult> {
  const { callbacks, meta, workerId, signal } = options ?? {};
  const { execution, output } = order;
  const messages = buildMessages(payload);

  // Build meta with workerId
  const l0Meta = { ...meta, workerId };

  // Parallel execution uses a completely different code path
  if (execution.parallel) {
    return await executeParallel(
      execution,
      messages,
      output,
      callbacks,
      l0Meta,
      signal,
    );
  }

  const primaryModel = execution.models[0];

  // For JSON output, use structured()
  if (output.kind === "json") {
    return await executeStructured(
      primaryModel,
      execution,
      messages,
      output,
      callbacks,
      l0Meta,
      signal,
    );
  }

  // For text/tokens, use l0() with streamText
  return await executeText(
    primaryModel,
    execution,
    messages,
    callbacks,
    l0Meta,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Shared L0 options builder
// ---------------------------------------------------------------------------

/**
 * Build the common L0 options shared between text and structured execution.
 * Wires: guardrails, timeout, signal, continueFromLastKnownGoodToken, onEvent.
 */
/** @internal Exported for testing */
export function buildCommonL0Options(
  execution: InferenceOrder["execution"],
  callbacks: ExecutionCallbacks | undefined,
  meta: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Partial<L0Options> {
  const opts: Partial<L0Options> = {
    retry: mapRetrySpec(execution.retry),
    meta: meta as Record<string, unknown> | undefined,
    onEvent: (event: L0Event) => {
      callbacks?.onL0Event?.(event);
    },
  };

  // Guardrails
  const guardrails = mapGuardrails(execution.guardrails);
  if (guardrails) {
    opts.guardrails = guardrails;
    if (execution.guardrails?.checkIntervalMs) {
      opts.checkIntervals = {
        ...opts.checkIntervals,
        guardrails: execution.guardrails.checkIntervalMs,
      };
    }
  }

  // Timeouts
  if (execution.timeout) {
    opts.timeout = {
      initialToken: execution.timeout.initialTokenMs,
      interToken: execution.timeout.interTokenMs,
    };
  }

  // AbortSignal
  if (signal) {
    opts.signal = signal;
  }

  // Token resumption
  if (execution.continueFromLastKnownGoodToken) {
    opts.continueFromLastKnownGoodToken = true;
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Tool support helpers
// ---------------------------------------------------------------------------

/**
 * Build AI SDK tool definitions from ToolSpec[].
 * Tools are schema-only (no server-side execution) — the model generates
 * tool call arguments which are captured and returned in ExecutionResult.
 */
/** @internal Exported for testing */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildTools(execution: InferenceOrder["execution"]): Record<string, any> | undefined {
  if (!execution.tools?.length) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};
  for (const t of execution.tools) {
    tools[t.name] = aiTool({
      description: t.description,
      inputSchema: jsonSchema(t.schema),
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Text execution
// ---------------------------------------------------------------------------

function buildTextStream(
  model: ModelSpec,
  messages: ModelMessage[],
  tools: Record<string, ReturnType<typeof aiTool>> | undefined,
) {
  const params = model.params ?? {};
  return () =>
    streamText({
      model: getModel(model),
      messages,
      tools,
      temperature: params.temperature as number | undefined,
      maxOutputTokens: params.maxOutputTokens as number | undefined,
      topP: params.topP as number | undefined,
      frequencyPenalty: params.frequencyPenalty as number | undefined,
      presencePenalty: params.presencePenalty as number | undefined,
      stopSequences: params.stop as string[] | undefined,
    });
}

async function executeText(
  primaryModel: ModelSpec,
  execution: InferenceOrder["execution"],
  messages: ModelMessage[],
  callbacks?: ExecutionCallbacks,
  meta?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  let firstTokenEmitted = false;
  let content = "";
  let tokenCount = 0;
  const toolCalls: Array<{ name: string; args: unknown }> = [];

  const tools = buildTools(execution);

  const commonOpts = buildCommonL0Options(execution, callbacks, meta, signal);

  const result = await l0({
    stream: buildTextStream(primaryModel, messages, tools),

    fallbackStreams: execution.fallbacks?.map((fb) =>
      buildTextStream(fb.model, messages, tools),
    ),

    ...commonOpts,
  } as L0Options);

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

  // Collect tool calls from l0 state if available
  if (result.state.toolCallNames) {
    for (const [id, name] of result.state.toolCallNames) {
      toolCalls.push({ name, args: { toolCallId: id } });
    }
  }

  return {
    content,
    tokenCount,
    inputTokens: result.state.inputTokens ?? 0,
    outputTokens: result.state.outputTokens ?? tokenCount,
    modelUsed: primaryModel,
    ...(toolCalls.length > 0 && { toolCalls }),
    ...(result.state.resumed && { resumed: true }),
  };
}

// ---------------------------------------------------------------------------
// Structured (JSON) execution
// ---------------------------------------------------------------------------

function buildStructuredStream(
  model: ModelSpec,
  messages: ModelMessage[],
  outputSpec: JsonOutput,
) {
  const params = model.params ?? {};
  return () => {
    return streamObject({
      model: getModel(model),
      messages,
      schema: jsonSchema(outputSpec.schema),
      temperature: params.temperature as number | undefined,
      maxOutputTokens: params.maxOutputTokens as number | undefined,
      topP: params.topP as number | undefined,
      frequencyPenalty: params.frequencyPenalty as number | undefined,
      presencePenalty: params.presencePenalty as number | undefined,
    });
  };
}

async function executeStructured(
  primaryModel: ModelSpec,
  execution: InferenceOrder["execution"],
  messages: ModelMessage[],
  outputSpec: JsonOutput,
  callbacks?: ExecutionCallbacks,
  meta?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  let firstTokenEmitted = false;
  let content = "";
  let tokenCount = 0;

  // Store reference to streamObject result to access .object promise later
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let streamObjectResult: { object: Promise<unknown> } | null = null;

  const commonOpts = buildCommonL0Options(execution, callbacks, meta, signal);

  const result = await l0({
    stream: () => {
      const res = streamObject({
        model: getModel(primaryModel),
        messages,
        schema: jsonSchema(outputSpec.schema),
        temperature: (primaryModel.params?.temperature as number) ?? undefined,
        maxOutputTokens:
          (primaryModel.params?.maxOutputTokens as number) ?? undefined,
        topP: (primaryModel.params?.topP as number) ?? undefined,
        frequencyPenalty:
          (primaryModel.params?.frequencyPenalty as number) ?? undefined,
        presencePenalty:
          (primaryModel.params?.presencePenalty as number) ?? undefined,
      });
      streamObjectResult = res;
      return res;
    },

    fallbackStreams: execution.fallbacks?.map((fb) => {
      return () => {
        const res = buildStructuredStream(fb.model, messages, outputSpec)();
        streamObjectResult = res;
        return res;
      };
    }),

    ...commonOpts,
  } as L0Options);

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
  let validatedOutput: unknown;
  if (streamObjectResult) {
    try {
      validatedOutput = await (
        streamObjectResult as { object: Promise<unknown> }
      ).object;
    } catch {
      // If object parsing fails, fall back to parsing the collected content
      try {
        validatedOutput = JSON.parse(content);
      } catch (parseError) {
        throw new OutputValidationError(
          `Failed to parse structured output: ${parseError instanceof Error ? parseError.message : "Invalid JSON"}`,
        );
      }
    }
  } else {
    try {
      validatedOutput = JSON.parse(content);
    } catch (parseError) {
      throw new OutputValidationError(
        `Failed to parse structured output: ${parseError instanceof Error ? parseError.message : "Invalid JSON"}`,
      );
    }
  }

  return {
    content: JSON.stringify(validatedOutput),
    tokenCount,
    inputTokens: result.state.inputTokens ?? 0,
    outputTokens: result.state.outputTokens ?? tokenCount,
    modelUsed: primaryModel,
    validatedOutput,
    ...(result.state.resumed && { resumed: true }),
  };
}

// ---------------------------------------------------------------------------
// Parallel / Race execution
// ---------------------------------------------------------------------------

async function executeParallel(
  execution: InferenceOrder["execution"],
  messages: ModelMessage[],
  output: InferenceOrder["output"],
  callbacks?: ExecutionCallbacks,
  meta?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  const mode = execution.parallel!.mode;
  const tools = buildTools(execution);

  // Build one L0Options per model in the preference list
  const operations: L0Options[] = execution.models.map((model) => {
    const commonOpts = buildCommonL0Options(execution, callbacks, meta, signal);
    const isJson = output.kind === "json";

    return {
      stream: isJson
        ? buildStructuredStream(model, messages, output as JsonOutput)
        : buildTextStream(model, messages, tools),
      ...commonOpts,
    } as L0Options;
  });

  if (mode === "race") {
    const raceResult = await race(operations);

    // Consume the winning stream
    let content = "";
    let tokenCount = 0;
    let firstTokenEmitted = false;

    for await (const event of raceResult.stream) {
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

    const winnerModel = execution.models[raceResult.winnerIndex] ?? execution.models[0];

    return {
      content,
      tokenCount,
      inputTokens: raceResult.state.inputTokens ?? 0,
      outputTokens: raceResult.state.outputTokens ?? tokenCount,
      modelUsed: winnerModel,
      ...(raceResult.state.resumed && { resumed: true }),
    };
  }

  // Fanout mode — run all models, return aggregated results as JSON array
  const parallelResult = await parallel(operations, {
    concurrency: execution.parallel!.max,
    failFast: false,
  });

  const outputs: string[] = [];
  let totalTokens = 0;
  let totalInput = 0;
  let totalOutput = 0;

  for (const res of parallelResult.results) {
    if (!res) {
      outputs.push("");
      continue;
    }
    // Consume each result stream
    let content = "";
    let count = 0;
    for await (const event of res.stream) {
      if (event.type === "token" && event.value) {
        content += event.value;
        count++;
      }
    }
    outputs.push(content);
    totalTokens += count;
    totalInput += res.state.inputTokens ?? 0;
    totalOutput += res.state.outputTokens ?? count;
  }

  const aggregated = JSON.stringify(outputs);

  return {
    content: aggregated,
    tokenCount: totalTokens,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    modelUsed: execution.models[0],
  };
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/** @internal Exported for testing */
export function mapRetrySpec(spec: RetrySpec | undefined):
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

/** @internal Exported for testing */
export function mapGuardrails(
  spec: GuardrailSpec | undefined,
): GuardrailRule[] | undefined {
  if (!spec?.preset) return undefined;

  const presetMap: Record<string, GuardrailRule[]> = {
    [GuardrailPreset.MINIMAL]: minimalGuardrails,
    [GuardrailPreset.RECOMMENDED]: recommendedGuardrails,
    [GuardrailPreset.STRICT]: strictGuardrails,
    [GuardrailPreset.JSON_ONLY]: jsonOnlyGuardrails,
    [GuardrailPreset.MARKDOWN_ONLY]: markdownOnlyGuardrails,
    [GuardrailPreset.LATEX_ONLY]: latexOnlyGuardrails,
  };

  return presetMap[spec.preset];
}

/** @internal Exported for testing */
export function buildMessages(payload: TaskPayload): ModelMessage[] {
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
