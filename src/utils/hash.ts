import { createHash } from "node:crypto";

/**
 * Compute SHA-256 hash of content for deterministic output verification.
 */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Recursively sort object keys for deterministic serialization.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Compute hash of an input payload for task identification.
 */
export function hashPayload(payload: unknown): string {
  const serialized = JSON.stringify(sortKeys(payload));
  return sha256(serialized);
}
