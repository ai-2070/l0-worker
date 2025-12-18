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
 * Deployment presets.
 */
const localPreset = {
  maxConcurrency: 64,
  functionTimeoutMs: 0, // No timeout for local
  drainBufferMs: 5000,
} as const;

const vercelPreset = {
  maxConcurrency: 1,
  functionTimeoutMs: 60000, // 60s Pro default
  drainBufferMs: 5000,
} as const;

/**
 * Determine which preset to use.
 * Set DEPLOYMENT=vercel for serverless, defaults to local.
 */
const isVercel = process.env.DEPLOYMENT === "vercel" || !!process.env.VERCEL;
const preset = isVercel ? vercelPreset : localPreset;

/**
 * L0 Worker configuration.
 * Environment variables override preset defaults.
 */
export const config = {
  workerId: process.env.WORKER_ID ?? uuidv7(),
  maxConcurrency: parseIntOrDefault(
    process.env.MAX_CONCURRENCY,
    preset.maxConcurrency,
  ),
  protocolVersion: "1.0.0",

  /**
   * Serverless function timeout in ms.
   * Set to 0 to disable drain timer (for long-running workers).
   * Vercel defaults: Hobby=10s, Pro=60s, Enterprise=900s
   */
  functionTimeoutMs: parseIntOrDefault(
    process.env.FUNCTION_TIMEOUT_MS,
    preset.functionTimeoutMs,
  ),

  /**
   * Buffer before function timeout to emit WORKER_DRAINING.
   * Only used if functionTimeoutMs > 0.
   */
  drainBufferMs: parseIntOrDefault(
    process.env.DRAIN_BUFFER_MS,
    preset.drainBufferMs,
  ),
} as const;
