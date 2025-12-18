import { AuthEnvelopeSchema } from "../events/inbound.js";

export type AuthResult = { valid: true } | { valid: false; reason: string };

/**
 * Validates ephemeral auth envelope.
 * - Format: token length, ttl positive
 * - Freshness: issued_at + ttl > now
 *
 * Token is validated once per invocation, never stored, never reused.
 */
export function validateAuth(auth: unknown): AuthResult {
  // Validate format
  const parsed = AuthEnvelopeSchema.safeParse(auth);
  if (!parsed.success) {
    return { valid: false, reason: "invalid_format" };
  }

  const { issued_at, ttl } = parsed.data;
  const now = Date.now();

  // Validate freshness
  const expires_at = issued_at + ttl;
  if (now > expires_at) {
    return { valid: false, reason: "expired" };
  }

  // Validate not issued in the future (clock skew tolerance: 5s)
  const CLOCK_SKEW_MS = 5000;
  if (issued_at > now + CLOCK_SKEW_MS) {
    return { valid: false, reason: "issued_in_future" };
  }

  return { valid: true };
}
