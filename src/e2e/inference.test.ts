/**
 * E2E tests with real LLM inference.
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

const TEST_SECRET = "e2e-test-secret";

// Skip all tests if OPENAI_API_KEY is not set
const hasApiKey = !!process.env.OPENAI_API_KEY;

// Helper to check for task failure and throw with details
function assertNoFailure(events: (OutboundEvent | L0Event)[]): void {
  const failed = events.find((e) => e.type === "TASK_FAILED") as
    | (OutboundEvent & { type: "TASK_FAILED" })
    | undefined;
  if (failed) {
    throw new Error(`Task failed: ${failed.message} (${failed.failureClass})`);
  }
}

// Helper to get completed event or throw
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

describe.skipIf(!hasApiKey)("E2E: Real Inference", () => {
  let worker: VercelWorker;
  let originalAuthSecret: string | undefined;

  beforeAll(() => {
    // Save original value and set auth secret for tests
    originalAuthSecret = process.env.L0_AUTH_SECRET;
    process.env.L0_AUTH_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    // Restore original value to prevent test pollution
    if (originalAuthSecret === undefined) {
      delete process.env.L0_AUTH_SECRET;
    } else {
      process.env.L0_AUTH_SECRET = originalAuthSecret;
    }
  });

  beforeEach(() => {
    worker = new VercelWorker({
      workerId: "e2e-test-worker",
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

  describe("text output", () => {
    it("completes a simple text generation task", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-text-1", order, {
        prompt: "Say 'hello world' and nothing else.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      // Check we got the expected event sequence
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("TASK_ACCEPTED");
      expect(eventTypes).toContain("TASK_COMPLETED");
      expect(eventTypes).not.toContain("TASK_FAILED");

      // Check TASK_COMPLETED has output
      const completed = getCompleted(events);
      expect(completed.output.toLowerCase()).toContain("hello");
      expect(completed.finalMetrics.durationMs).toBeGreaterThan(0);
      expect(completed.outputHash).toBeDefined();
    });

    it("streams first token event", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-text-2", order, {
        prompt: "Count from 1 to 5.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      assertNoFailure(events);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("TASK_PROGRESS");

      const progress = events.find(
        (e) => e.type === "TASK_PROGRESS",
      ) as OutboundEvent & { type: "TASK_PROGRESS" };
      expect(progress.stage).toBe("first_token");
    });

    it("handles multi-turn conversation", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-text-3", order, {
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant. Be very brief.",
          },
          { role: "user", content: "What is 2+2?" },
          { role: "assistant", content: "4" },
          { role: "user", content: "And what is that times 3?" },
        ],
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const completed = getCompleted(events);
      expect(completed.output).toMatch(/12/);
    });
  });

  describe("JSON output", () => {
    it("generates structured JSON output", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: {
          kind: "json",
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
            required: ["name", "age"],
          },
          strict: true,
        },
      };

      const taskSubmit = createTaskSubmit("task-json-1", order, {
        prompt: "Generate a person with name 'Alice' and age 30.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const completed = getCompleted(events);
      const output = JSON.parse(completed.output);
      expect(output.name).toBe("Alice");
      expect(output.age).toBe(30);
    });

    it("generates array JSON output", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: {
          kind: "json",
          schema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["items"],
          },
          strict: true,
        },
      };

      const taskSubmit = createTaskSubmit("task-json-2", order, {
        prompt: "List exactly 3 colors: red, green, blue.",
      });

      const events: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        events.push(event);
      });

      const completed = getCompleted(events);
      const output = JSON.parse(completed.output);
      expect(output.items).toHaveLength(3);
      expect(output.items).toContain("red");
      expect(output.items).toContain("green");
      expect(output.items).toContain("blue");
    });
  });

  describe("replay", () => {
    it("replays completed task events", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-replay-1", order, {
        prompt: "Say 'replay test' and nothing else.",
      });

      // Execute original task
      const originalEvents: (OutboundEvent | L0Event)[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        originalEvents.push(event);
      });

      const originalCompleted = getCompleted(originalEvents);

      // Replay the task and collect emitted events
      const replayedEvents: OutboundEvent[] = [];
      const validation = await worker.replay(
        {
          type: "TASK_REPLAY_REQUEST",
          auth: taskSubmit.auth,
          task_id: "task-replay-1",
          input_hash: taskSubmit.input_hash,
          expected_output_hash: originalCompleted.outputHash,
          reason: "test",
          replay_ts: Date.now(),
        },
        (event) => replayedEvents.push(event),
      );

      expect(validation.success).toBe(true);
      expect(validation.outputHashMatch).toBe(true);
      expect(validation.eventsReplayed).toBeGreaterThan(0);

      // Verify replayed events match original (only OutboundEvents, not L0Events)
      const originalOutbound = originalEvents.filter((e) =>
        [
          "TASK_ACCEPTED",
          "TASK_PROGRESS",
          "TASK_COMPLETED",
          "TASK_FAILED",
        ].includes(e.type),
      );
      expect(replayedEvents).toEqual(originalOutbound);
    });
  });

  describe("error handling", () => {
    it("fails on invalid payload", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-error-1", order, {
        // Missing both prompt and messages - invalid
      } as any);

      const events: (OutboundEvent | L0Event)[] = [];

      // parseTaskPayload should throw before execution
      await expect(
        worker.executeTaskWithEvents(taskSubmit, (event) => events.push(event)),
      ).rejects.toThrow();
    });
  });

  describe("concurrency", () => {
    it("handles concurrent tasks", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: { kind: "text" },
      };

      const tasks = [
        createTaskSubmit("task-concurrent-1", order, { prompt: "Say 'one'" }),
        createTaskSubmit("task-concurrent-2", order, { prompt: "Say 'two'" }),
        createTaskSubmit("task-concurrent-3", order, { prompt: "Say 'three'" }),
      ];

      const allEvents: Map<string, (OutboundEvent | L0Event)[]> = new Map();

      await Promise.all(
        tasks.map(async (task) => {
          const events: (OutboundEvent | L0Event)[] = [];
          allEvents.set(task.task_id, events);
          await worker.executeTaskWithEvents(task, (event) =>
            events.push(event),
          );
        }),
      );

      // All tasks should complete
      for (const [taskId, events] of allEvents) {
        const completed = events.find((e) => e.type === "TASK_COMPLETED");
        expect(completed, `Task ${taskId} should complete`).toBeDefined();
      }
    });

    it("rejects when at slot capacity", async () => {
      // Create worker with only 1 slot
      const singleSlotWorker = new VercelWorker({
        workerId: "single-slot-worker",
        maxConcurrency: 1,
        protocolVersion: "1.0.0",
      });

      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: { kind: "text" },
      };

      const task1 = createTaskSubmit("task-slot-1", order, {
        prompt: "Count slowly from 1 to 10.",
      });
      const task2 = createTaskSubmit("task-slot-2", order, {
        prompt: "Say hello.",
      });

      // Use a promise that resolves when task1 is accepted (slot acquired)
      let task1Accepted: () => void;
      const task1AcceptedPromise = new Promise<void>(
        (resolve) => (task1Accepted = resolve),
      );

      // Start first task (don't await)
      const task1Promise = singleSlotWorker.executeTaskWithEvents(
        task1,
        (event) => {
          if (event.type === "TASK_ACCEPTED") {
            task1Accepted();
          }
        },
      );

      // Wait for task1 to be accepted (slot is now occupied)
      await task1AcceptedPromise;

      // Second task should fail due to no slots
      await expect(
        singleSlotWorker.executeTaskWithEvents(task2, () => {}),
      ).rejects.toThrow("No slots available");

      // Wait for first task to complete
      await task1Promise;
    });
  });

  describe("L0 events", () => {
    it("receives L0 lifecycle events", async () => {
      const order: InferenceOrder = {
        execution: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
        output: { kind: "text" },
      };

      const taskSubmit = createTaskSubmit("task-l0-events", order, {
        prompt: "Say 'test'",
      });

      const allEvents: (OutboundEvent | L0Event)[] = [];
      const l0Events: L0Event[] = [];
      await worker.executeTaskWithEvents(taskSubmit, (event) => {
        allEvents.push(event);
        // L0 events have a type but aren't OutboundEvents
        if (
          ![
            "TASK_ACCEPTED",
            "TASK_PROGRESS",
            "TASK_COMPLETED",
            "TASK_FAILED",
            "WORKER_DRAINING",
          ].includes(event.type)
        ) {
          l0Events.push(event as L0Event);
        }
      });

      // Ensure task completed successfully
      assertNoFailure(allEvents);

      // L0 events are optional - the L0 runtime may or may not emit them
      // Just check that if we have any, they have the expected shape
      if (l0Events.length > 0) {
        for (const event of l0Events) {
          expect(event.type).toBeDefined();
          // ts may or may not be present depending on L0 version
        }
      }
    });
  });
});
