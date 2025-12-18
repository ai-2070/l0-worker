import { v7 as uuidv7 } from "uuid";

function parseIntOrDefault(
  value: string | undefined,
  defaultValue: number,
): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * L0 Worker configuration defaults.
 */
export const config = {
  workerId: process.env.WORKER_ID ?? uuidv7(),
  maxConcurrency: parseIntOrDefault(process.env.MAX_CONCURRENCY, 1),
  protocolVersion: "1.0.0",

  /**
   * Serverless function timeout in ms.
   * Set to 0 or omit to disable drain timer (for long-running workers).
   * Vercel defaults: Hobby=10s, Pro=60s, Enterprise=900s
   */
  functionTimeoutMs: parseIntOrDefault(process.env.FUNCTION_TIMEOUT_MS, 0),

  /**
   * Buffer before function timeout to emit WORKER_DRAINING.
   * Only used if functionTimeoutMs > 0.
   */
  drainBufferMs: parseIntOrDefault(process.env.DRAIN_BUFFER_MS, 5000),
} as const;
