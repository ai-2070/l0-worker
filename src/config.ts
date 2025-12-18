import { v7 as uuidv7 } from "uuid";

/**
 * L0 Worker configuration defaults.
 */
export const config = {
  workerId: process.env.WORKER_ID ?? `l0-${uuidv7()}`,
  maxConcurrency: parseInt(process.env.MAX_CONCURRENCY ?? "1", 10),
  protocolVersion: "1.0.0",

  /**
   * Serverless function timeout in ms.
   * Set to 0 or omit to disable drain timer (for long-running workers).
   * Vercel defaults: Hobby=10s, Pro=60s, Enterprise=900s
   */
  functionTimeoutMs: process.env.FUNCTION_TIMEOUT_MS
    ? parseInt(process.env.FUNCTION_TIMEOUT_MS, 10)
    : 0,

  /**
   * Buffer before function timeout to emit WORKER_DRAINING.
   * Only used if functionTimeoutMs > 0.
   */
  drainBufferMs: parseInt(process.env.DRAIN_BUFFER_MS ?? "5000", 10),
} as const;
