import { createHash } from "node:crypto";

/**
 * Compute SHA-256 hash of content for deterministic output verification.
 */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Recursively sort object keys for deterministic serialization.
 * Only handles enumerable string keys (suitable for JSON-serializable data).
 * Objects with toJSON (like Date) are passed through for JSON.stringify to handle.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  // Let JSON.stringify handle objects with toJSON (Date, etc.)
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return value;
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
