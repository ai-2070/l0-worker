import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkerStateMachine, WorkerState } from "./machine.js";

describe("WorkerStateMachine", () => {
  let machine: WorkerStateMachine;

  beforeEach(() => {
    machine = new WorkerStateMachine();
  });

  describe("initial state", () => {
    it("starts in BOOT state", () => {
      expect(machine.state).toBe(WorkerState.BOOT);
    });

    it("is not accepting in BOOT state", () => {
      expect(machine.isAccepting()).toBe(false);
    });

    it("is not offline in BOOT state", () => {
      expect(machine.isOffline()).toBe(false);
    });

    it("is not draining in BOOT state", () => {
      expect(machine.isDraining()).toBe(false);
    });
  });

  describe("valid transitions from BOOT", () => {
    it("can transition to READY", () => {
      expect(machine.canTransition(WorkerState.READY)).toBe(true);
      machine.transition(WorkerState.READY);
      expect(machine.state).toBe(WorkerState.READY);
    });

    it("cannot transition to ACCEPTING directly", () => {
      expect(machine.canTransition(WorkerState.ACCEPTING)).toBe(false);
      expect(() => machine.transition(WorkerState.ACCEPTING)).toThrow(
        "Invalid state transition: BOOT -> ACCEPTING"
      );
    });

    it("cannot transition to DRAINING directly", () => {
      expect(machine.canTransition(WorkerState.DRAINING)).toBe(false);
    });

    it("cannot transition to OFFLINE directly", () => {
      expect(machine.canTransition(WorkerState.OFFLINE)).toBe(false);
    });
  });

  describe("valid transitions from READY", () => {
    beforeEach(() => {
      machine.transition(WorkerState.READY);
    });

    it("can transition to ACCEPTING", () => {
      expect(machine.canTransition(WorkerState.ACCEPTING)).toBe(true);
      machine.transition(WorkerState.ACCEPTING);
      expect(machine.state).toBe(WorkerState.ACCEPTING);
    });

    it("can transition to DRAINING", () => {
      expect(machine.canTransition(WorkerState.DRAINING)).toBe(true);
      machine.transition(WorkerState.DRAINING);
      expect(machine.state).toBe(WorkerState.DRAINING);
    });

    it("can transition to OFFLINE", () => {
      expect(machine.canTransition(WorkerState.OFFLINE)).toBe(true);
      machine.transition(WorkerState.OFFLINE);
      expect(machine.state).toBe(WorkerState.OFFLINE);
    });

    it("cannot transition back to BOOT", () => {
      expect(machine.canTransition(WorkerState.BOOT)).toBe(false);
    });

    it("is accepting in READY state", () => {
      expect(machine.isAccepting()).toBe(true);
    });
  });

  describe("valid transitions from ACCEPTING", () => {
    beforeEach(() => {
      machine.transition(WorkerState.READY);
      machine.transition(WorkerState.ACCEPTING);
    });

    it("can transition to DRAINING", () => {
      expect(machine.canTransition(WorkerState.DRAINING)).toBe(true);
      machine.transition(WorkerState.DRAINING);
      expect(machine.state).toBe(WorkerState.DRAINING);
    });

    it("can transition to OFFLINE", () => {
      expect(machine.canTransition(WorkerState.OFFLINE)).toBe(true);
      machine.transition(WorkerState.OFFLINE);
      expect(machine.state).toBe(WorkerState.OFFLINE);
    });

    it("cannot transition back to READY", () => {
      expect(machine.canTransition(WorkerState.READY)).toBe(false);
    });

    it("cannot transition back to BOOT", () => {
      expect(machine.canTransition(WorkerState.BOOT)).toBe(false);
    });

    it("is accepting in ACCEPTING state", () => {
      expect(machine.isAccepting()).toBe(true);
    });
  });

  describe("valid transitions from DRAINING", () => {
    beforeEach(() => {
      machine.transition(WorkerState.READY);
      machine.transition(WorkerState.DRAINING);
    });

    it("can only transition to OFFLINE", () => {
      expect(machine.canTransition(WorkerState.OFFLINE)).toBe(true);
      expect(machine.canTransition(WorkerState.BOOT)).toBe(false);
      expect(machine.canTransition(WorkerState.READY)).toBe(false);
      expect(machine.canTransition(WorkerState.ACCEPTING)).toBe(false);
    });

    it("is draining", () => {
      expect(machine.isDraining()).toBe(true);
    });

    it("is not accepting", () => {
      expect(machine.isAccepting()).toBe(false);
    });
  });

  describe("OFFLINE is terminal", () => {
    beforeEach(() => {
      machine.transition(WorkerState.READY);
      machine.transition(WorkerState.OFFLINE);
    });

    it("cannot transition to any state", () => {
      expect(machine.canTransition(WorkerState.BOOT)).toBe(false);
      expect(machine.canTransition(WorkerState.READY)).toBe(false);
      expect(machine.canTransition(WorkerState.ACCEPTING)).toBe(false);
      expect(machine.canTransition(WorkerState.DRAINING)).toBe(false);
      expect(machine.canTransition(WorkerState.OFFLINE)).toBe(false);
    });

    it("throws on any transition attempt", () => {
      expect(() => machine.transition(WorkerState.READY)).toThrow(
        "Invalid state transition: OFFLINE -> READY"
      );
    });

    it("is offline", () => {
      expect(machine.isOffline()).toBe(true);
    });

    it("is not accepting", () => {
      expect(machine.isAccepting()).toBe(false);
    });

    it("is not draining", () => {
      expect(machine.isDraining()).toBe(false);
    });
  });

  describe("onTransition listener", () => {
    it("calls listener on transition", () => {
      const listener = vi.fn();
      machine.onTransition(listener);

      machine.transition(WorkerState.READY);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(WorkerState.BOOT, WorkerState.READY);
    });

    it("calls multiple listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      machine.onTransition(listener1);
      machine.onTransition(listener2);

      machine.transition(WorkerState.READY);

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it("returns unsubscribe function", () => {
      const listener = vi.fn();
      const unsubscribe = machine.onTransition(listener);

      machine.transition(WorkerState.READY);
      expect(listener).toHaveBeenCalledOnce();

      unsubscribe();
      machine.transition(WorkerState.ACCEPTING);
      expect(listener).toHaveBeenCalledOnce(); // Not called again
    });

    it("handles listener removal during iteration", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      // First listener removes itself when called
      let unsubscribe1: () => void;
      const selfRemovingListener = vi.fn(() => {
        unsubscribe1();
      });

      unsubscribe1 = machine.onTransition(selfRemovingListener);
      machine.onTransition(listener2);

      machine.transition(WorkerState.READY);

      expect(selfRemovingListener).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });
  });

  describe("full lifecycle", () => {
    it("supports BOOT -> READY -> ACCEPTING -> DRAINING -> OFFLINE", () => {
      expect(machine.state).toBe(WorkerState.BOOT);

      machine.transition(WorkerState.READY);
      expect(machine.state).toBe(WorkerState.READY);
      expect(machine.isAccepting()).toBe(true);

      machine.transition(WorkerState.ACCEPTING);
      expect(machine.state).toBe(WorkerState.ACCEPTING);
      expect(machine.isAccepting()).toBe(true);

      machine.transition(WorkerState.DRAINING);
      expect(machine.state).toBe(WorkerState.DRAINING);
      expect(machine.isDraining()).toBe(true);
      expect(machine.isAccepting()).toBe(false);

      machine.transition(WorkerState.OFFLINE);
      expect(machine.state).toBe(WorkerState.OFFLINE);
      expect(machine.isOffline()).toBe(true);
    });

    it("supports BOOT -> READY -> OFFLINE (immediate shutdown)", () => {
      machine.transition(WorkerState.READY);
      machine.transition(WorkerState.OFFLINE);
      expect(machine.isOffline()).toBe(true);
    });
  });
});
