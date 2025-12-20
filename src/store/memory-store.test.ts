import { describe, it, expect, beforeEach } from "vitest";
import { MemoryEventStore } from "./memory-store.js";
import type { OutboundEvent, TaskAcceptedEvent, TaskCompletedEvent, TaskFailedEvent } from "../events/index.js";
import { FailureClass } from "../events/index.js";

describe("MemoryEventStore", () => {
  let store: MemoryEventStore;

  const createAcceptedEvent = (taskId: string): TaskAcceptedEvent => ({
    type: "TASK_ACCEPTED",
    taskId,
    workerId: "worker-1",
    ts: Date.now(),
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
    ts: Date.now(),
  });

  const createFailedEvent = (taskId: string): TaskFailedEvent => ({
    type: "TASK_FAILED",
    taskId,
    workerId: "worker-1",
    failureClass: FailureClass.TIMEOUT,
    retryable: true,
    message: "Task timed out",
    ts: Date.now(),
  });

  beforeEach(() => {
    store = new MemoryEventStore();
  });

  describe("record", () => {
    it("records events for a task", async () => {
      const event = createAcceptedEvent("task-1");
      await store.record("task-1", event);

      const events = await store.getEventsForTask("task-1");
      expect(events).toHaveLength(1);
      expect(events[0]).toBe(event);
    });

    it("appends multiple events for the same task", async () => {
      const accepted = createAcceptedEvent("task-1");
      const completed = createCompletedEvent("task-1", "hash-123");

      await store.record("task-1", accepted);
      await store.record("task-1", completed);

      const events = await store.getEventsForTask("task-1");
      expect(events).toHaveLength(2);
      expect(events[0]).toBe(accepted);
      expect(events[1]).toBe(completed);
    });

    it("keeps events separate per task", async () => {
      const event1 = createAcceptedEvent("task-1");
      const event2 = createAcceptedEvent("task-2");

      await store.record("task-1", event1);
      await store.record("task-2", event2);

      const events1 = await store.getEventsForTask("task-1");
      const events2 = await store.getEventsForTask("task-2");

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect(events1[0]).toBe(event1);
      expect(events2[0]).toBe(event2);
    });
  });

  describe("getEventsForTask", () => {
    it("returns empty array for non-existent task", async () => {
      const events = await store.getEventsForTask("non-existent");
      expect(events).toEqual([]);
    });

    it("returns all recorded events in order", async () => {
      const events: OutboundEvent[] = [
        createAcceptedEvent("task-1"),
        createCompletedEvent("task-1", "hash-1"),
      ];

      for (const event of events) {
        await store.record("task-1", event);
      }

      const retrieved = await store.getEventsForTask("task-1");
      expect(retrieved).toEqual(events);
    });
  });

  describe("hasTask", () => {
    it("returns false for non-existent task", async () => {
      expect(await store.hasTask("non-existent")).toBe(false);
    });

    it("returns true for recorded task", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      expect(await store.hasTask("task-1")).toBe(true);
    });

    it("returns false after task is cleared", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.clearTask("task-1");
      expect(await store.hasTask("task-1")).toBe(false);
    });
  });

  describe("getOutputHash", () => {
    it("returns null for non-existent task", async () => {
      expect(await store.getOutputHash("non-existent")).toBe(null);
    });

    it("returns null for task without TASK_COMPLETED event", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      expect(await store.getOutputHash("task-1")).toBe(null);
    });

    it("returns null for failed task", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-1", createFailedEvent("task-1"));
      expect(await store.getOutputHash("task-1")).toBe(null);
    });

    it("returns output hash for completed task", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-1", createCompletedEvent("task-1", "expected-hash"));
      expect(await store.getOutputHash("task-1")).toBe("expected-hash");
    });
  });

  describe("clearTask", () => {
    it("removes all events for a task", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-1", createCompletedEvent("task-1", "hash"));

      await store.clearTask("task-1");

      expect(await store.getEventsForTask("task-1")).toEqual([]);
      expect(await store.hasTask("task-1")).toBe(false);
    });

    it("does not affect other tasks", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-2", createAcceptedEvent("task-2"));

      await store.clearTask("task-1");

      expect(await store.hasTask("task-1")).toBe(false);
      expect(await store.hasTask("task-2")).toBe(true);
    });

    it("is safe to call on non-existent task", async () => {
      await expect(store.clearTask("non-existent")).resolves.not.toThrow();
    });
  });

  describe("clear", () => {
    it("removes all events from all tasks", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-2", createAcceptedEvent("task-2"));

      store.clear();

      expect(store.size()).toBe(0);
      expect(await store.hasTask("task-1")).toBe(false);
      expect(await store.hasTask("task-2")).toBe(false);
    });
  });

  describe("size", () => {
    it("returns 0 for empty store", () => {
      expect(store.size()).toBe(0);
    });

    it("returns number of tasks (not events)", async () => {
      await store.record("task-1", createAcceptedEvent("task-1"));
      await store.record("task-1", createCompletedEvent("task-1", "hash"));
      await store.record("task-2", createAcceptedEvent("task-2"));

      expect(store.size()).toBe(2);
    });
  });

  describe("maxTasks eviction", () => {
    it("does not evict when maxTasks is 0 (unlimited)", async () => {
      const unlimitedStore = new MemoryEventStore(0);

      for (let i = 0; i < 100; i++) {
        await unlimitedStore.record(`task-${i}`, createAcceptedEvent(`task-${i}`));
      }

      expect(unlimitedStore.size()).toBe(100);
    });

    it("evicts oldest task when at capacity", async () => {
      const limitedStore = new MemoryEventStore(2);

      await limitedStore.record("task-1", createAcceptedEvent("task-1"));
      await limitedStore.record("task-2", createAcceptedEvent("task-2"));
      await limitedStore.record("task-3", createAcceptedEvent("task-3"));

      expect(limitedStore.size()).toBe(2);
      expect(await limitedStore.hasTask("task-1")).toBe(false); // Evicted
      expect(await limitedStore.hasTask("task-2")).toBe(true);
      expect(await limitedStore.hasTask("task-3")).toBe(true);
    });

    it("does not evict when adding events to existing task", async () => {
      const limitedStore = new MemoryEventStore(2);

      await limitedStore.record("task-1", createAcceptedEvent("task-1"));
      await limitedStore.record("task-2", createAcceptedEvent("task-2"));
      // Add another event to task-1 (should not trigger eviction)
      await limitedStore.record("task-1", createCompletedEvent("task-1", "hash"));

      expect(limitedStore.size()).toBe(2);
      expect(await limitedStore.hasTask("task-1")).toBe(true);
      expect(await limitedStore.hasTask("task-2")).toBe(true);
    });

    it("uses FIFO order for eviction", async () => {
      const limitedStore = new MemoryEventStore(3);

      await limitedStore.record("task-1", createAcceptedEvent("task-1"));
      await limitedStore.record("task-2", createAcceptedEvent("task-2"));
      await limitedStore.record("task-3", createAcceptedEvent("task-3"));
      await limitedStore.record("task-4", createAcceptedEvent("task-4"));
      await limitedStore.record("task-5", createAcceptedEvent("task-5"));

      expect(limitedStore.size()).toBe(3);
      expect(await limitedStore.hasTask("task-1")).toBe(false); // First evicted
      expect(await limitedStore.hasTask("task-2")).toBe(false); // Second evicted
      expect(await limitedStore.hasTask("task-3")).toBe(true);
      expect(await limitedStore.hasTask("task-4")).toBe(true);
      expect(await limitedStore.hasTask("task-5")).toBe(true);
    });
  });
});
