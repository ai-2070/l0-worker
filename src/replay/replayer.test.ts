import { describe, it, expect, beforeEach, vi } from "vitest";
import { Replayer } from "./replayer.js";
import { MemoryEventStore } from "../store/memory-store.js";
import type { OutboundEvent, TaskAcceptedEvent, TaskCompletedEvent, TaskProgressEvent } from "../events/index.js";
import { ProgressStage } from "../events/index.js";

describe("Replayer", () => {
  let store: MemoryEventStore;
  let replayer: Replayer;

  const createAcceptedEvent = (taskId: string): TaskAcceptedEvent => ({
    type: "TASK_ACCEPTED",
    taskId,
    workerId: "worker-1",
    ts: 1000,
  });

  const createProgressEvent = (taskId: string): TaskProgressEvent => ({
    type: "TASK_PROGRESS",
    taskId,
    stage: ProgressStage.FIRST_TOKEN,
    ts: 1500,
  });

  const createCompletedEvent = (taskId: string, outputHash: string): TaskCompletedEvent => ({
    type: "TASK_COMPLETED",
    taskId,
    workerId: "worker-1",
    finalMetrics: {
      durationMs: 100,
      tokenCount: 50,
      promptTokens: 20,
      completionTokens: 30,
    },
    outputHash,
    output: "test output",
    ts: 2000,
  });

  beforeEach(() => {
    store = new MemoryEventStore();
    replayer = new Replayer(store);
  });

  describe("canReplay", () => {
    it("returns false for non-existent task", async () => {
      expect(await replayer.canReplay("non-existent")).toBe(false);
    });

    it("returns true for recorded task", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      expect(await replayer.canReplay("task-1")).toBe(true);
    });
  });

  describe("getRecordedOutputHash", () => {
    it("returns null for non-existent task", async () => {
      expect(await replayer.getRecordedOutputHash("non-existent")).toBe(null);
    });

    it("returns null for incomplete task", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      expect(await replayer.getRecordedOutputHash("task-1")).toBe(null);
    });

    it("returns output hash for completed task", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-1", createCompletedEvent("task-1", "expected-hash"));
      expect(await replayer.getRecordedOutputHash("task-1")).toBe("expected-hash");
    });
  });

  describe("replay (async generator)", () => {
    it("yields no events for non-existent task", async () => {
      const events: OutboundEvent[] = [];
      for await (const event of replayer.replay("non-existent")) {
        events.push(event);
      }
      expect(events).toEqual([]);
    });

    it("yields all recorded events in order", async () => {
      const accepted = createAcceptedEvent("task-1");
      const progress = createProgressEvent("task-1");
      const completed = createCompletedEvent("task-1", "hash");

      await store.record("task-1", accepted);
      await store.record("task-1", progress);
      await store.record("task-1", completed);

      const events: OutboundEvent[] = [];
      for await (const event of replayer.replay("task-1")) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0]).toBe(accepted);
      expect(events[1]).toBe(progress);
      expect(events[2]).toBe(completed);
    });

    it("yields exact same event objects (no modification)", async () => {
      const original = createAcceptedEvent("task-1");
      await store.record("task-1", original);

      const events: OutboundEvent[] = [];
      for await (const event of replayer.replay("task-1")) {
        events.push(event);
      }

      expect(events[0]).toBe(original); // Same reference
    });
  });

  describe("replayWithValidation", () => {
    it("returns error for non-existent task", async () => {
      const emit = vi.fn();
      const result = await replayer.replayWithValidation("non-existent", undefined, emit);

      expect(result.success).toBe(false);
      expect(result.eventsReplayed).toBe(0);
      expect(result.outputHashMatch).toBe(null);
      expect(result.error).toContain("No recorded events for task non-existent");
      expect(emit).not.toHaveBeenCalled();
    });

    it("emits all events via callback", async () => {
      const accepted = createAcceptedEvent("task-1");
      const completed = createCompletedEvent("task-1", "hash");

      await store.record("task-1", accepted);
      await store.record("task-1", completed);

      const emit = vi.fn();
      const result = await replayer.replayWithValidation("task-1", undefined, emit);

      expect(result.success).toBe(true);
      expect(result.eventsReplayed).toBe(2);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenNthCalledWith(1, accepted);
      expect(emit).toHaveBeenNthCalledWith(2, completed);
    });

    it("returns null outputHashMatch when no expected hash provided", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-1", createCompletedEvent("task-1", "actual-hash"));

      const emit = vi.fn();
      const result = await replayer.replayWithValidation("task-1", undefined, emit);

      expect(result.outputHashMatch).toBe(null);
    });

    it("returns true outputHashMatch when hashes match", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-1", createCompletedEvent("task-1", "matching-hash"));

      const emit = vi.fn();
      const result = await replayer.replayWithValidation("task-1", "matching-hash", emit);

      expect(result.outputHashMatch).toBe(true);
    });

    it("returns false outputHashMatch when hashes don't match", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-1", createCompletedEvent("task-1", "actual-hash"));

      const emit = vi.fn();
      const result = await replayer.replayWithValidation("task-1", "expected-hash", emit);

      expect(result.outputHashMatch).toBe(false);
    });

    it("returns null outputHashMatch when task has no TASK_COMPLETED", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-1", createProgressEvent("task-1"));

      const emit = vi.fn();
      const result = await replayer.replayWithValidation("task-1", "expected-hash", emit);

      // No TASK_COMPLETED event means no outputHash to compare
      expect(result.outputHashMatch).toBe(null);
    });

    it("handles empty event list for a task", async () => {
      // Edge case: task exists but has no events (shouldn't happen in practice)
      // The store's hasTask would return false, so we get the error case
      const emit = vi.fn();
      const result = await replayer.replayWithValidation("task-1", undefined, emit);

      expect(result.success).toBe(false);
    });
  });

  describe("determinism guarantees", () => {
    it("replay does not modify stored events", async () => {
      const original = createAcceptedEvent("task-1");
      await store.record("task-1", original);

      // Replay multiple times
      for (let i = 0; i < 3; i++) {
        const events: OutboundEvent[] = [];
        for await (const event of replayer.replay("task-1")) {
          events.push(event);
        }
        expect(events[0]).toBe(original);
      }

      // Verify the stored event is unchanged
      const stored = await store.getEventsForTask("task-1");
      expect(stored[0]).toBe(original);
    });

    it("multiple replays yield identical results", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-1", createProgressEvent("task-1"));
      await store.record("task-1", createCompletedEvent("task-1", "hash"));

      const collectEvents = async (): Promise<OutboundEvent[]> => {
        const events: OutboundEvent[] = [];
        for await (const event of replayer.replay("task-1")) {
          events.push(event);
        }
        return events;
      };

      const replay1 = await collectEvents();
      const replay2 = await collectEvents();
      const replay3 = await collectEvents();

      expect(replay1).toEqual(replay2);
      expect(replay2).toEqual(replay3);
    });
  });
});
