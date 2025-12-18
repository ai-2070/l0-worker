import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthEnvelopeSchema } from "../events/inbound.js";

export type AuthResult = { valid: true } | { valid: false; reason: string };

/**
 * Clock skew tolerance for issued_at validation.
 */
const CLOCK_SKEW_MS = 5000;

/**
 * Get the auth secret from environment.
 * Returns null if not configured (auth disabled).
 */
function getAuthSecret(): string | null {
  return process.env.L0_AUTH_SECRET || null;
}

/**
 * Compute HMAC-SHA256 signature for auth validation.
 * Signs: task_id|issued_at|ttl
 */
function computeSignature(
  secret: string,
  taskId: string,
  issuedAt: number,
  ttl: number,
): string {
  const payload = `${taskId}|${issuedAt}|${ttl}`;
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64");
}

/**
 * Constant-time comparison of two strings.
 */
function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Validates ephemeral auth envelope with HMAC verification.
 *
 * Validation steps:
 * 1. Format: token length >= 32, ttl positive
 * 2. Freshness: issued_at + ttl > now
 * 3. Clock skew: issued_at not more than 5 seconds in future
 * 4. Signature: token matches HMAC-SHA256(secret, task_id|issued_at|ttl)
 *
 * If L0_AUTH_SECRET is not set, signature verification is skipped (dev mode).
 * Token is validated once per invocation, never stored, never reused.
 *
 * @param auth - The auth envelope from the request
 * @param taskId - The task_id used in signature computation
 */
export function validateAuth(auth: unknown, taskId: string): AuthResult {
  // Validate format
  const parsed = AuthEnvelopeSchema.safeParse(auth);
  if (!parsed.success) {
    return { valid: false, reason: "invalid_format" };
  }

  const { token, issued_at, ttl } = parsed.data;
  const now = Date.now();

  // Validate freshness
  const expires_at = issued_at + ttl;
  if (now > expires_at) {
    return { valid: false, reason: "expired" };
  }

  // Validate not issued in the future (clock skew tolerance)
  if (issued_at > now + CLOCK_SKEW_MS) {
    return { valid: false, reason: "issued_in_future" };
  }

  // Validate HMAC signature if secret is configured
  const secret = getAuthSecret();
  if (secret) {
    const expectedSignature = computeSignature(secret, taskId, issued_at, ttl);
    if (!secureCompare(token, expectedSignature)) {
      return { valid: false, reason: "invalid_signature" };
    }
  }

  return { valid: true };
}

/**
 * Generate a valid auth token for a task (for L1 use).
 * Exported for testing and L1 integration.
 */
export function generateAuthToken(
  secret: string,
  taskId: string,
  issuedAt: number,
  ttl: number,
): string {
  return computeSignature(secret, taskId, issuedAt, ttl);
}
