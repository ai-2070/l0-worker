import { z } from "zod";

/**
 * Worker configuration schema.
 */
export const WorkerConfigSchema = z.object({
  workerId: z.string(),
  maxConcurrency: z.number().min(1).default(4),
  protocolVersion: z.string().default("1.0.0"),
  l1Address: z.string().optional(),
  loadReportIntervalMs: z.number().min(1000).default(5000).optional(),
  loadReportThreshold: z.number().min(0).max(1).default(0.1).optional(),
});

export type WorkerConfigInput = {
  workerId: string;
  maxConcurrency?: number;
  protocolVersion?: string;
  l1Address?: string;
  loadReportIntervalMs?: number;
  loadReportThreshold?: number;
};

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/**
 * Runtime configuration that can be hot-updated.
 */
export interface RuntimeConfig {
  maxConcurrency: number;
  resourceCaps: Record<string, number>;
  featureFlags: Record<string, boolean>;
}

/**
 * Configuration manager with hot-reload support.
 */
export class ConfigManager {
  private config: WorkerConfig;
  private runtime: RuntimeConfig;
  private readonly listeners: Array<(config: RuntimeConfig) => void> = [];

  constructor(config: WorkerConfigInput) {
    this.config = {
      workerId: config.workerId,
      maxConcurrency: config.maxConcurrency ?? 4,
      protocolVersion: config.protocolVersion ?? "1.0.0",
      l1Address: config.l1Address,
      loadReportIntervalMs: config.loadReportIntervalMs ?? 5000,
      loadReportThreshold: config.loadReportThreshold ?? 0.1,
    };
    this.runtime = {
      maxConcurrency: this.config.maxConcurrency,
      resourceCaps: {},
      featureFlags: {},
    };
  }

  get workerId(): string {
    return this.config.workerId;
  }

  get protocolVersion(): string {
    return this.config.protocolVersion;
  }

  get l1Address(): string | undefined {
    return this.config.l1Address;
  }

  get loadReportIntervalMs(): number {
    return this.config.loadReportIntervalMs ?? 5000;
  }

  get loadReportThreshold(): number {
    return this.config.loadReportThreshold ?? 0.1;
  }

  get maxConcurrency(): number {
    return this.runtime.maxConcurrency;
  }

  get resourceCaps(): Record<string, number> {
    return this.runtime.resourceCaps;
  }

  get featureFlags(): Record<string, boolean> {
    return this.runtime.featureFlags;
  }

  /**
   * Apply a hot config update.
   */
  update(update: {
    maxConcurrency?: number;
    resourceCaps?: Record<string, number>;
    featureFlags?: Record<string, boolean>;
  }): void {
    if (update.maxConcurrency !== undefined) {
      this.runtime.maxConcurrency = update.maxConcurrency;
    }
    if (update.resourceCaps !== undefined) {
      this.runtime.resourceCaps = {
        ...this.runtime.resourceCaps,
        ...update.resourceCaps,
      };
    }
    if (update.featureFlags !== undefined) {
      this.runtime.featureFlags = {
        ...this.runtime.featureFlags,
        ...update.featureFlags,
      };
    }
    for (const listener of this.listeners) {
      listener(this.runtime);
    }
  }

  /**
   * Subscribe to config updates.
   */
  onUpdate(listener: (config: RuntimeConfig) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }
}
