import { describe, it, expect, beforeEach } from "vitest";
import { SlotManager } from "./slots.js";

describe("SlotManager", () => {
  let slots: SlotManager;

  beforeEach(() => {
    slots = new SlotManager(2);
  });

  describe("constructor", () => {
    it("initializes with given max concurrency", () => {
      expect(slots.maxConcurrency).toBe(2);
      expect(slots.inflightCount).toBe(0);
      expect(slots.availableCount).toBe(2);
    });

    it("throws if maxConcurrency is less than 1", () => {
      expect(() => new SlotManager(0)).toThrow("maxConcurrency must be at least 1");
      expect(() => new SlotManager(-1)).toThrow("maxConcurrency must be at least 1");
    });
  });

  describe("maxConcurrency setter", () => {
    it("updates max concurrency", () => {
      slots.maxConcurrency = 5;
      expect(slots.maxConcurrency).toBe(5);
      expect(slots.availableCount).toBe(5);
    });

    it("throws if set to less than 1", () => {
      expect(() => { slots.maxConcurrency = 0; }).toThrow("maxConcurrency must be at least 1");
    });

    it("allows reducing below current inflight count", () => {
      slots.acquire("task-1");
      slots.acquire("task-2");
      slots.maxConcurrency = 1;
      expect(slots.maxConcurrency).toBe(1);
      expect(slots.availableCount).toBe(0); // Math.max(0, 1 - 2)
    });
  });

  describe("acquire", () => {
    it("returns 'acquired' when slots available", () => {
      expect(slots.acquire("task-1")).toBe("acquired");
      expect(slots.inflightCount).toBe(1);
      expect(slots.availableCount).toBe(1);
    });

    it("returns 'no_slots' when at capacity", () => {
      slots.acquire("task-1");
      slots.acquire("task-2");
      expect(slots.acquire("task-3")).toBe("no_slots");
      expect(slots.inflightCount).toBe(2);
    });

    it("returns 'duplicate' for same task ID", () => {
      slots.acquire("task-1");
      expect(slots.acquire("task-1")).toBe("duplicate");
      expect(slots.inflightCount).toBe(1);
    });

    it("tracks slot info with startedAt timestamp", () => {
      const before = Date.now();
      slots.acquire("task-1");
      const after = Date.now();

      const info = slots.getSlotInfo("task-1");
      expect(info).toBeDefined();
      expect(info!.taskId).toBe("task-1");
      expect(info!.startedAt).toBeGreaterThanOrEqual(before);
      expect(info!.startedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("release", () => {
    it("returns true when releasing existing task", () => {
      slots.acquire("task-1");
      expect(slots.release("task-1")).toBe(true);
      expect(slots.inflightCount).toBe(0);
      expect(slots.availableCount).toBe(2);
    });

    it("returns false when releasing non-existent task", () => {
      expect(slots.release("non-existent")).toBe(false);
    });

    it("allows new task after release", () => {
      slots.acquire("task-1");
      slots.acquire("task-2");
      expect(slots.acquire("task-3")).toBe("no_slots");

      slots.release("task-1");
      expect(slots.acquire("task-3")).toBe("acquired");
    });
  });

  describe("hasSlot", () => {
    it("returns true for acquired task", () => {
      slots.acquire("task-1");
      expect(slots.hasSlot("task-1")).toBe(true);
    });

    it("returns false for non-existent task", () => {
      expect(slots.hasSlot("task-1")).toBe(false);
    });

    it("returns false after release", () => {
      slots.acquire("task-1");
      slots.release("task-1");
      expect(slots.hasSlot("task-1")).toBe(false);
    });
  });

  describe("hasAvailableSlot", () => {
    it("returns true when slots available", () => {
      expect(slots.hasAvailableSlot()).toBe(true);
      slots.acquire("task-1");
      expect(slots.hasAvailableSlot()).toBe(true);
    });

    it("returns false when at capacity", () => {
      slots.acquire("task-1");
      slots.acquire("task-2");
      expect(slots.hasAvailableSlot()).toBe(false);
    });
  });

  describe("getInflightTaskIds", () => {
    it("returns empty array when no tasks", () => {
      expect(slots.getInflightTaskIds()).toEqual([]);
    });

    it("returns all inflight task IDs", () => {
      slots.acquire("task-1");
      slots.acquire("task-2");
      expect(slots.getInflightTaskIds()).toEqual(["task-1", "task-2"]);
    });

    it("excludes released tasks", () => {
      slots.acquire("task-1");
      slots.acquire("task-2");
      slots.release("task-1");
      expect(slots.getInflightTaskIds()).toEqual(["task-2"]);
    });
  });

  describe("clear", () => {
    it("removes all slots", () => {
      slots.acquire("task-1");
      slots.acquire("task-2");
      slots.clear();
      expect(slots.inflightCount).toBe(0);
      expect(slots.availableCount).toBe(2);
      expect(slots.getInflightTaskIds()).toEqual([]);
    });
  });

  describe("concurrency edge cases", () => {
    it("handles single slot concurrency", () => {
      const singleSlot = new SlotManager(1);
      expect(singleSlot.acquire("task-1")).toBe("acquired");
      expect(singleSlot.acquire("task-2")).toBe("no_slots");
      singleSlot.release("task-1");
      expect(singleSlot.acquire("task-2")).toBe("acquired");
    });

    it("handles high concurrency", () => {
      const highConcurrency = new SlotManager(100);
      for (let i = 0; i < 100; i++) {
        expect(highConcurrency.acquire(`task-${i}`)).toBe("acquired");
      }
      expect(highConcurrency.acquire("task-100")).toBe("no_slots");
      expect(highConcurrency.inflightCount).toBe(100);
    });
  });
});
