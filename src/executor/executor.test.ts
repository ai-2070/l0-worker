import { describe, it, expect } from "vitest";
import {
  mapRetrySpec,
  mapGuardrails,
  buildMessages,
  buildCommonL0Options,
  buildTools,
  OutputValidationError,
} from "./executor.js";
import {
  minimalGuardrails,
  recommendedGuardrails,
  strictGuardrails,
  jsonOnlyGuardrails,
  markdownOnlyGuardrails,
  latexOnlyGuardrails,
} from "@ai2070/l0";
import type { InferenceOrder } from "../inference/index.js";

// ---------------------------------------------------------------------------
// mapRetrySpec
// ---------------------------------------------------------------------------

describe("mapRetrySpec", () => {
  it("returns undefined for undefined input", () => {
    expect(mapRetrySpec(undefined)).toBeUndefined();
  });

  it("maps all fields correctly", () => {
    const result = mapRetrySpec({
      attempts: 3,
      maxRetries: 6,
      backoff: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    });

    expect(result).toEqual({
      attempts: 3,
      maxRetries: 6,
      backoff: "exponential",
      baseDelay: 1000,
      maxDelay: 30000,
    });
  });

  it("handles optional delay fields", () => {
    const result = mapRetrySpec({
      attempts: 1,
      maxRetries: 2,
      backoff: "fixed",
    });

    expect(result).toEqual({
      attempts: 1,
      maxRetries: 2,
      backoff: "fixed",
      baseDelay: undefined,
      maxDelay: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// mapGuardrails
// ---------------------------------------------------------------------------

describe("mapGuardrails", () => {
  it("returns undefined for undefined input", () => {
    expect(mapGuardrails(undefined)).toBeUndefined();
  });

  it("returns undefined when no preset is specified", () => {
    expect(mapGuardrails({})).toBeUndefined();
    expect(mapGuardrails({ checkIntervalMs: 500 })).toBeUndefined();
  });

  it("maps 'minimal' preset", () => {
    expect(mapGuardrails({ preset: "minimal" })).toBe(minimalGuardrails);
  });

  it("maps 'recommended' preset", () => {
    expect(mapGuardrails({ preset: "recommended" })).toBe(
      recommendedGuardrails,
    );
  });

  it("maps 'strict' preset", () => {
    expect(mapGuardrails({ preset: "strict" })).toBe(strictGuardrails);
  });

  it("maps 'json-only' preset", () => {
    expect(mapGuardrails({ preset: "json-only" })).toBe(jsonOnlyGuardrails);
  });

  it("maps 'markdown-only' preset", () => {
    expect(mapGuardrails({ preset: "markdown-only" })).toBe(
      markdownOnlyGuardrails,
    );
  });

  it("maps 'latex-only' preset", () => {
    expect(mapGuardrails({ preset: "latex-only" })).toBe(latexOnlyGuardrails);
  });
});

// ---------------------------------------------------------------------------
// buildMessages
// ---------------------------------------------------------------------------

describe("buildMessages", () => {
  it("converts prompt to user message", () => {
    const result = buildMessages({ prompt: "Hello" });
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("passes messages through as-is", () => {
    const messages = [
      { role: "system" as const, content: "You are helpful" },
      { role: "user" as const, content: "Hi" },
    ];
    const result = buildMessages({ messages });
    expect(result).toEqual(messages);
  });

  it("prefers messages over prompt when both present", () => {
    const messages = [{ role: "user" as const, content: "from messages" }];
    const result = buildMessages({ prompt: "from prompt", messages });
    expect(result).toEqual(messages);
  });

  it("throws when neither prompt nor messages provided", () => {
    expect(() => buildMessages({} as any)).toThrow(
      "Payload must have either prompt or messages",
    );
  });
});

// ---------------------------------------------------------------------------
// buildCommonL0Options
// ---------------------------------------------------------------------------

describe("buildCommonL0Options", () => {
  const baseExecution: InferenceOrder["execution"] = {
    models: [{ provider: "openai", model: "gpt-4o" }],
  };

  it("returns base options with retry and onEvent", () => {
    const opts = buildCommonL0Options(baseExecution, undefined, undefined, undefined);
    expect(opts.retry).toBeUndefined();
    expect(opts.onEvent).toBeDefined();
    expect(opts.guardrails).toBeUndefined();
    expect(opts.timeout).toBeUndefined();
    expect(opts.signal).toBeUndefined();
    expect(opts.continueFromLastKnownGoodToken).toBeUndefined();
  });

  it("wires timeout config", () => {
    const execution = {
      ...baseExecution,
      timeout: { initialTokenMs: 5000, interTokenMs: 2000 },
    };
    const opts = buildCommonL0Options(execution, undefined, undefined, undefined);
    expect(opts.timeout).toEqual({ initialToken: 5000, interToken: 2000 });
  });

  it("wires partial timeout config", () => {
    const execution = {
      ...baseExecution,
      timeout: { initialTokenMs: 3000 },
    };
    const opts = buildCommonL0Options(execution, undefined, undefined, undefined);
    expect(opts.timeout).toEqual({ initialToken: 3000, interToken: undefined });
  });

  it("wires guardrails preset", () => {
    const execution = {
      ...baseExecution,
      guardrails: { preset: "recommended" as const },
    };
    const opts = buildCommonL0Options(execution, undefined, undefined, undefined);
    expect(opts.guardrails).toBe(recommendedGuardrails);
  });

  it("wires guardrails checkInterval", () => {
    const execution = {
      ...baseExecution,
      guardrails: { preset: "strict" as const, checkIntervalMs: 500 },
    };
    const opts = buildCommonL0Options(execution, undefined, undefined, undefined);
    expect(opts.guardrails).toBe(strictGuardrails);
    expect(opts.checkIntervals?.guardrails).toBe(500);
  });

  it("does not set checkIntervals without guardrails preset", () => {
    const execution = {
      ...baseExecution,
      guardrails: { checkIntervalMs: 500 },
    };
    const opts = buildCommonL0Options(execution, undefined, undefined, undefined);
    expect(opts.guardrails).toBeUndefined();
    expect(opts.checkIntervals).toBeUndefined();
  });

  it("wires AbortSignal", () => {
    const controller = new AbortController();
    const opts = buildCommonL0Options(
      baseExecution,
      undefined,
      undefined,
      controller.signal,
    );
    expect(opts.signal).toBe(controller.signal);
  });

  it("does not set signal when undefined", () => {
    const opts = buildCommonL0Options(baseExecution, undefined, undefined, undefined);
    expect(opts.signal).toBeUndefined();
  });

  it("wires continueFromLastKnownGoodToken", () => {
    const execution = {
      ...baseExecution,
      continueFromLastKnownGoodToken: true,
    };
    const opts = buildCommonL0Options(execution, undefined, undefined, undefined);
    expect(opts.continueFromLastKnownGoodToken).toBe(true);
  });

  it("does not set continueFromLastKnownGoodToken when false", () => {
    const execution = {
      ...baseExecution,
      continueFromLastKnownGoodToken: false,
    };
    const opts = buildCommonL0Options(execution, undefined, undefined, undefined);
    expect(opts.continueFromLastKnownGoodToken).toBeUndefined();
  });

  it("wires retry spec", () => {
    const execution = {
      ...baseExecution,
      retry: {
        attempts: 3,
        maxRetries: 5,
        backoff: "exponential" as const,
        baseDelayMs: 1000,
      },
    };
    const opts = buildCommonL0Options(execution, undefined, undefined, undefined);
    expect(opts.retry).toEqual({
      attempts: 3,
      maxRetries: 5,
      backoff: "exponential",
      baseDelay: 1000,
      maxDelay: undefined,
    });
  });

  it("forwards L0 events to callback", () => {
    const events: unknown[] = [];
    const callbacks = {
      onL0Event: (event: unknown) => events.push(event),
    };
    const opts = buildCommonL0Options(baseExecution, callbacks, undefined, undefined);
    const fakeEvent = { type: "SESSION_START", ts: 1000 };
    opts.onEvent!(fakeEvent as any);
    expect(events).toEqual([fakeEvent]);
  });

  it("passes meta through", () => {
    const meta = { workerId: "w-1", requestId: "r-1" };
    const opts = buildCommonL0Options(baseExecution, undefined, meta, undefined);
    expect(opts.meta).toEqual(meta);
  });

  it("wires all options together", () => {
    const controller = new AbortController();
    const execution = {
      ...baseExecution,
      timeout: { initialTokenMs: 5000, interTokenMs: 2000 },
      guardrails: { preset: "recommended" as const, checkIntervalMs: 300 },
      continueFromLastKnownGoodToken: true,
      retry: { attempts: 2, maxRetries: 4, backoff: "fixed" as const },
    };
    const opts = buildCommonL0Options(
      execution,
      undefined,
      { workerId: "w-1" },
      controller.signal,
    );

    expect(opts.timeout).toEqual({ initialToken: 5000, interToken: 2000 });
    expect(opts.guardrails).toBe(recommendedGuardrails);
    expect(opts.checkIntervals?.guardrails).toBe(300);
    expect(opts.continueFromLastKnownGoodToken).toBe(true);
    expect(opts.signal).toBe(controller.signal);
    expect(opts.retry).toBeDefined();
    expect(opts.meta).toEqual({ workerId: "w-1" });
  });
});

// ---------------------------------------------------------------------------
// buildTools
// ---------------------------------------------------------------------------

describe("buildTools", () => {
  it("returns undefined when no tools specified", () => {
    expect(buildTools({ models: [{ provider: "openai", model: "gpt-4o" }] })).toBeUndefined();
  });

  it("returns undefined for empty tools array", () => {
    expect(
      buildTools({
        models: [{ provider: "openai", model: "gpt-4o" }],
        tools: [],
      }),
    ).toBeUndefined();
  });

  it("builds tool definitions from ToolSpec", () => {
    const result = buildTools({
      models: [{ provider: "openai", model: "gpt-4o" }],
      tools: [
        {
          name: "get_weather",
          description: "Get current weather",
          schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    });

    expect(result).toBeDefined();
    expect(result!.get_weather).toBeDefined();
    expect(result!.get_weather.description).toBe("Get current weather");
  });

  it("builds multiple tools", () => {
    const result = buildTools({
      models: [{ provider: "openai", model: "gpt-4o" }],
      tools: [
        { name: "tool_a", schema: { type: "object", properties: {} } },
        { name: "tool_b", schema: { type: "object", properties: {} } },
      ],
    });

    expect(result).toBeDefined();
    expect(Object.keys(result!)).toEqual(["tool_a", "tool_b"]);
  });

  it("handles tools without description", () => {
    const result = buildTools({
      models: [{ provider: "openai", model: "gpt-4o" }],
      tools: [
        { name: "no_desc", schema: { type: "object", properties: {} } },
      ],
    });

    expect(result).toBeDefined();
    expect(result!.no_desc).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Schema validation for new fields
// ---------------------------------------------------------------------------

describe("InferenceOrder schema validation", async () => {
  const { InferenceOrderSchema } = await import("../inference/order.js");

  it("accepts order with timeout", () => {
    const result = InferenceOrderSchema.safeParse({
      execution: {
        models: [{ provider: "openai", model: "gpt-4o" }],
        timeout: { initialTokenMs: 5000, interTokenMs: 2000 },
      },
      output: { kind: "text" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts order with guardrails preset", () => {
    const result = InferenceOrderSchema.safeParse({
      execution: {
        models: [{ provider: "openai", model: "gpt-4o" }],
        guardrails: { preset: "recommended", checkIntervalMs: 500 },
      },
      output: { kind: "text" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid guardrail preset", () => {
    const result = InferenceOrderSchema.safeParse({
      execution: {
        models: [{ provider: "openai", model: "gpt-4o" }],
        guardrails: { preset: "nonexistent" },
      },
      output: { kind: "text" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts order with continueFromLastKnownGoodToken", () => {
    const result = InferenceOrderSchema.safeParse({
      execution: {
        models: [{ provider: "openai", model: "gpt-4o" }],
        continueFromLastKnownGoodToken: true,
      },
      output: { kind: "text" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts order with tools including description", () => {
    const result = InferenceOrderSchema.safeParse({
      execution: {
        models: [{ provider: "openai", model: "gpt-4o" }],
        tools: [
          {
            name: "get_weather",
            description: "Get weather for a city",
            schema: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
      },
      output: { kind: "text" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts order with all new fields combined", () => {
    const result = InferenceOrderSchema.safeParse({
      execution: {
        models: [{ provider: "openai", model: "gpt-4o" }],
        timeout: { initialTokenMs: 10000 },
        guardrails: { preset: "strict" },
        continueFromLastKnownGoodToken: true,
        tools: [
          { name: "calc", schema: { type: "object", properties: {} } },
        ],
        parallel: { mode: "race" },
      },
      output: { kind: "text" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative timeout values", () => {
    const result = InferenceOrderSchema.safeParse({
      execution: {
        models: [{ provider: "openai", model: "gpt-4o" }],
        timeout: { initialTokenMs: -1 },
      },
      output: { kind: "text" },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OutputValidationError
// ---------------------------------------------------------------------------

describe("OutputValidationError", () => {
  it("includes reason in message", () => {
    const error = new OutputValidationError("bad json");
    expect(error.message).toBe("Output validation failed: bad json");
    expect(error.reason).toBe("bad json");
    expect(error.name).toBe("OutputValidationError");
  });

  it("is instanceof Error", () => {
    const error = new OutputValidationError("test");
    expect(error).toBeInstanceOf(Error);
  });
});
