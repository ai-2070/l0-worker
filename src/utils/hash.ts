import { createHash } from "node:crypto";

/**
 * Compute SHA-256 hash of content for deterministic output verification.
 */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Compute hash of an input payload for task identification.
 */
export function hashPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload, Object.keys(payload as object).sort());
  return sha256(serialized);
}
