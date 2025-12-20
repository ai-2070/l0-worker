import { describe, it, expect, vi } from "vitest";
import { ConfigManager, WorkerConfigSchema } from "./config.js";

describe("WorkerConfigSchema", () => {
  it("requires workerId", () => {
    expect(() => WorkerConfigSchema.parse({})).toThrow();
  });

  it("accepts minimal config with just workerId", () => {
    const config = WorkerConfigSchema.parse({ workerId: "worker-1" });
    expect(config.workerId).toBe("worker-1");
    expect(config.maxConcurrency).toBe(4); // default
    expect(config.protocolVersion).toBe("1.0.0"); // default
  });

  it("accepts full config", () => {
    const config = WorkerConfigSchema.parse({
      workerId: "worker-1",
      maxConcurrency: 10,
      protocolVersion: "2.0.0",
      l1Address: "https://l1.example.com",
      loadReportIntervalMs: 10000,
      loadReportThreshold: 0.5,
    });
    expect(config.workerId).toBe("worker-1");
    expect(config.maxConcurrency).toBe(10);
    expect(config.protocolVersion).toBe("2.0.0");
    expect(config.l1Address).toBe("https://l1.example.com");
    expect(config.loadReportIntervalMs).toBe(10000);
    expect(config.loadReportThreshold).toBe(0.5);
  });

  it("rejects maxConcurrency less than 1", () => {
    expect(() =>
      WorkerConfigSchema.parse({ workerId: "worker-1", maxConcurrency: 0 })
    ).toThrow();
  });

  it("rejects loadReportIntervalMs less than 1000", () => {
    expect(() =>
      WorkerConfigSchema.parse({ workerId: "worker-1", loadReportIntervalMs: 500 })
    ).toThrow();
  });

  it("rejects loadReportThreshold outside 0-1 range", () => {
    expect(() =>
      WorkerConfigSchema.parse({ workerId: "worker-1", loadReportThreshold: -0.1 })
    ).toThrow();
    expect(() =>
      WorkerConfigSchema.parse({ workerId: "worker-1", loadReportThreshold: 1.1 })
    ).toThrow();
  });
});

describe("ConfigManager", () => {
  describe("constructor", () => {
    it("initializes with provided config", () => {
      const manager = new ConfigManager({
        workerId: "worker-1",
        maxConcurrency: 8,
        protocolVersion: "1.0.0",
      });

      expect(manager.workerId).toBe("worker-1");
      expect(manager.maxConcurrency).toBe(8);
      expect(manager.protocolVersion).toBe("1.0.0");
    });

    it("uses defaults for optional fields", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });

      expect(manager.maxConcurrency).toBe(4);
      expect(manager.protocolVersion).toBe("1.0.0");
      expect(manager.loadReportIntervalMs).toBe(5000);
      expect(manager.loadReportThreshold).toBe(0.1);
    });

    it("initializes runtime config from static config", () => {
      const manager = new ConfigManager({
        workerId: "worker-1",
        maxConcurrency: 16,
      });

      expect(manager.maxConcurrency).toBe(16);
      expect(manager.resourceCaps).toEqual({});
      expect(manager.featureFlags).toEqual({});
    });

    it("throws on invalid config", () => {
      expect(() => new ConfigManager({ workerId: "" } as any)).not.toThrow(); // empty string is valid
      expect(() => new ConfigManager({} as any)).toThrow();
    });
  });

  describe("getters", () => {
    it("returns l1Address when set", () => {
      const manager = new ConfigManager({
        workerId: "worker-1",
        l1Address: "https://l1.example.com",
      });
      expect(manager.l1Address).toBe("https://l1.example.com");
    });

    it("returns undefined l1Address when not set", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });
      expect(manager.l1Address).toBeUndefined();
    });

    it("returns copies of resourceCaps and featureFlags", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });
      manager.update({
        resourceCaps: { memory: 1024 },
        featureFlags: { newFeature: true },
      });

      const caps = manager.resourceCaps;
      const flags = manager.featureFlags;

      // Mutating returned objects should not affect internal state
      caps.memory = 9999;
      flags.newFeature = false;

      expect(manager.resourceCaps.memory).toBe(1024);
      expect(manager.featureFlags.newFeature).toBe(true);
    });
  });

  describe("update", () => {
    it("updates maxConcurrency", () => {
      const manager = new ConfigManager({ workerId: "worker-1", maxConcurrency: 4 });
      manager.update({ maxConcurrency: 16 });
      expect(manager.maxConcurrency).toBe(16);
    });

    it("throws if maxConcurrency is less than 1", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });
      expect(() => manager.update({ maxConcurrency: 0 })).toThrow(
        "maxConcurrency must be at least 1"
      );
      expect(() => manager.update({ maxConcurrency: -1 })).toThrow(
        "maxConcurrency must be at least 1"
      );
    });

    it("merges resourceCaps", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });

      manager.update({ resourceCaps: { memory: 1024 } });
      expect(manager.resourceCaps).toEqual({ memory: 1024 });

      manager.update({ resourceCaps: { cpu: 4 } });
      expect(manager.resourceCaps).toEqual({ memory: 1024, cpu: 4 });

      manager.update({ resourceCaps: { memory: 2048 } });
      expect(manager.resourceCaps).toEqual({ memory: 2048, cpu: 4 });
    });

    it("merges featureFlags", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });

      manager.update({ featureFlags: { featureA: true } });
      expect(manager.featureFlags).toEqual({ featureA: true });

      manager.update({ featureFlags: { featureB: false } });
      expect(manager.featureFlags).toEqual({ featureA: true, featureB: false });

      manager.update({ featureFlags: { featureA: false } });
      expect(manager.featureFlags).toEqual({ featureA: false, featureB: false });
    });

    it("handles partial updates", () => {
      const manager = new ConfigManager({ workerId: "worker-1", maxConcurrency: 4 });

      manager.update({ maxConcurrency: 8 });
      expect(manager.maxConcurrency).toBe(8);
      expect(manager.resourceCaps).toEqual({});

      manager.update({ resourceCaps: { memory: 1024 } });
      expect(manager.maxConcurrency).toBe(8);
      expect(manager.resourceCaps).toEqual({ memory: 1024 });
    });

    it("handles empty update", () => {
      const manager = new ConfigManager({ workerId: "worker-1", maxConcurrency: 4 });
      manager.update({});
      expect(manager.maxConcurrency).toBe(4);
    });
  });

  describe("onUpdate", () => {
    it("calls listener on update", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });
      const listener = vi.fn();

      manager.onUpdate(listener);
      manager.update({ maxConcurrency: 8 });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({
        maxConcurrency: 8,
        resourceCaps: {},
        featureFlags: {},
      });
    });

    it("calls multiple listeners", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      manager.onUpdate(listener1);
      manager.onUpdate(listener2);
      manager.update({ maxConcurrency: 8 });

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it("returns unsubscribe function", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });
      const listener = vi.fn();

      const unsubscribe = manager.onUpdate(listener);
      manager.update({ maxConcurrency: 8 });
      expect(listener).toHaveBeenCalledOnce();

      unsubscribe();
      manager.update({ maxConcurrency: 16 });
      expect(listener).toHaveBeenCalledOnce(); // Not called again
    });

    it("handles listener removal during iteration", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });
      const listener2 = vi.fn();

      let unsubscribe1: () => void;
      const selfRemovingListener = vi.fn(() => {
        unsubscribe1();
      });

      unsubscribe1 = manager.onUpdate(selfRemovingListener);
      manager.onUpdate(listener2);

      manager.update({ maxConcurrency: 8 });

      expect(selfRemovingListener).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it("does not call listener if update throws", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });
      const listener = vi.fn();

      manager.onUpdate(listener);

      expect(() => manager.update({ maxConcurrency: 0 })).toThrow();
      expect(listener).not.toHaveBeenCalled();
    });

    it("passes current runtime config to listener", () => {
      const manager = new ConfigManager({ workerId: "worker-1" });
      manager.update({ resourceCaps: { memory: 1024 } });

      const listener = vi.fn();
      manager.onUpdate(listener);
      manager.update({ featureFlags: { newFeature: true } });

      expect(listener).toHaveBeenCalledWith({
        maxConcurrency: 4,
        resourceCaps: { memory: 1024 },
        featureFlags: { newFeature: true },
      });
    });
  });
});
