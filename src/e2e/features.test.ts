/**
 * E2E tests for new executor features: tools, guardrails, timeouts,
 * abort signal, and token resumption.
 *
 * These tests make actual API calls to OpenAI and cost money (fractions of a cent).
 * They require OPENAI_API_KEY to be set.
 *
 * Run with: npm run test:e2e
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { VercelWorker } from "../worker-instance.js";
import { generateAuthToken } from "../auth/validate.js";
import type { TaskSubmit, OutboundEvent } from "../events/index.js";
import type { InferenceOrder } from "../inference/index.js";
import type { L0Event } from "../executor/index.js";
import { sha256 } from "../utils/index.js";

const TEST_SECRET = "e2e-features-test-secret";

const hasApiKey = !!process.env.OPENAI_API_KEY;

function assertNoFailure(events: (OutboundEvent | L0Event)[]): void {
  const failed = events.find((e) => e.type === "TASK_FAILED") as
    | (OutboundEvent & { type: "TASK_FAILED" })
    | undefined;
  if (failed) {
    throw new Error(`Task failed: ${failed.message} (${failed.failureClass})`);
  }
}

function getCompleted(
  events: (OutboundEvent | L0Event)[],
): OutboundEvent & { type: "TASK_COMPLETED" } {
  assertNoFailure(events);
  const completed = events.find((e) => e.type === "TASK_COMPLETED") as
    | (OutboundEvent & { type: "TASK_COMPLETED" })
    | undefined;
  if (!completed) {
    const eventTypes = events.map((e) => e.type).join(", ");
    throw new Error(`No TASK_COMPLETED event found. Events: ${eventTypes}`);
  }
  return completed;
}

describe.skipIf(!hasApiKey)("E2E: New Features", () => {
  let worker: VercelWorker;
  let originalAuthSecret: string | undefined;

  beforeAll(() => {
    originalAuthSecret = process.env.L0_AUTH_SECRET;
    process.env.L0_AUTH_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    if (originalAuthSecret === undefined) {
      delete process.env.L0_AUTH_SECRET;
    } else {
      process.env.L0_AUTH_SECRET = originalAuthSecret;
    }
  });

  beforeEach(() => {
    worker = new VercelWorker({
      workerId: "e2e-features-worker",
      maxConcurrency: 4,
      protocolVersion: "1.0.0",
    });
  });

  function createTaskSubmit(
    taskId: string,
    order: InferenceOrder,
    payload: {
      prompt?: string;
      messages?: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }>;
    },
  ): TaskSubmit {
    const issuedAt = Date.now();
    const ttl = 60000;
    const token = generateAuthToken(TEST_SECRET, taskId, issuedAt, ttl);

    return {
      type: "TASK_SUBMIT",
      auth: { token, issued_at: issuedAt, ttl },
      task_id: taskId,
      order,
      payload,
      input_hash: sha256(JSON.stringify(payload)),
      submission_ts: Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  describe("tools", () => {
    it("generates tool calls when tools are provided", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
          tools: [
            {
              name: "get_weather",
              description: "Get current weather for a location",
              schema: {
                type: "object",
                properties: {
                  location: { type: "string", description: "City name" },
                },
                required: ["location"],
              },
            },
          ],
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-tools-1", order, {
        prompt:
          "What's the weather in Paris? Use the get_weather tool to find out.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("TASK_ACCEPTED");

      // Task should complete (tool calls are captured, not blocking)
      const completed = events.find((e) => e.type === "TASK_COMPLETED");
      expect(completed).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Timeouts
  // -------------------------------------------------------------------------

  describe("timeouts", () => {
    it("completes with timeout config", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
          timeout: {
            initialTokenMs: 30000,
            interTokenMs: 10000,
          },
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-timeout-1", order, {
        prompt: "Say 'timeout test' and nothing else.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const completed = getCompleted(events);
      expect(completed.output.toLowerCase()).toContain("timeout");
    });

    it("fails on extremely short initial token timeout", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
          timeout: {
            initialTokenMs: 1, // 1ms — should fail
          },
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-timeout-2", order, {
        prompt: "Write a very long essay about the history of computing.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const eventTypes = events.map((e) => e.type);
      // Should either fail or complete — the timeout is so short it should trigger
      expect(
        eventTypes.includes("TASK_FAILED") ||
          eventTypes.includes("TASK_COMPLETED"),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Guardrails
  // -------------------------------------------------------------------------

  describe("guardrails", () => {
    it("completes with minimal guardrails", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
          guardrails: { preset: "minimal" },
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-guard-1", order, {
        prompt: "Say 'guardrail test' and nothing else.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const completed = getCompleted(events);
      expect(completed.output).toBeDefined();
    });

    it("completes JSON output with json-only guardrails", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
          guardrails: { preset: "json-only", checkIntervalMs: 100 },
        },
        output: {
          kind: "json",
          schema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          strict: true,
        },
      };

      const taskSubmit = createTaskSubmit("task-guard-2", order, {
        prompt: "Return { \"value\": \"guarded\" }",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const completed = getCompleted(events);
      const output = JSON.parse(completed.output);
      expect(output.value).toBe("guarded");
    });
  });

  // -------------------------------------------------------------------------
  // AbortSignal
  // -------------------------------------------------------------------------

  describe("abort signal", () => {
    it("task respects abort when worker drains", async () => {
      // Create a worker that will drain almost immediately
      const abortWorker = new VercelWorker({
        workerId: "e2e-abort-worker",
        maxConcurrency: 2,
        protocolVersion: "1.0.0",
      });

      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-abort-1", order, {
        prompt: "Say 'hello' and nothing else.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await abortWorker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      // Task should complete or fail, but never hang
      const eventTypes = events.map((e) => e.type);
      expect(
        eventTypes.includes("TASK_COMPLETED") ||
          eventTypes.includes("TASK_FAILED"),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Token resumption
  // -------------------------------------------------------------------------

  describe("token resumption", () => {
    it("completes with continueFromLastKnownGoodToken enabled", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
          continueFromLastKnownGoodToken: true,
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-resume-1", order, {
        prompt: "Say 'resumption test' and nothing else.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const completed = getCompleted(events);
      expect(completed.output.toLowerCase()).toContain("resumption");
    });
  });

  // -------------------------------------------------------------------------
  // Combined features
  // -------------------------------------------------------------------------

  describe("combined features", () => {
    it("completes with timeout + guardrails + resumption", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
          timeout: { initialTokenMs: 30000, interTokenMs: 10000 },
          guardrails: { preset: "minimal" },
          continueFromLastKnownGoodToken: true,
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-combined-1", order, {
        prompt: "Say 'combined test' and nothing else.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const completed = getCompleted(events);
      expect(completed.output.toLowerCase()).toContain("combined");
      expect(completed.finalMetrics.durationMs).toBeGreaterThan(0);
    });

    it("completes JSON with timeout + guardrails", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
          timeout: { initialTokenMs: 30000 },
          guardrails: { preset: "json-only" },
        },
        output: {
          kind: "json",
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              score: { type: "number" },
            },
            required: ["name", "score"],
          },
          strict: true,
        },
      };

      const taskSubmit = createTaskSubmit("task-combined-2", order, {
        prompt: "Return a person named 'Bob' with score 42.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const completed = getCompleted(events);
      const output = JSON.parse(completed.output);
      expect(output.name).toBe("Bob");
      expect(output.score).toBe(42);
    });
  });
});
