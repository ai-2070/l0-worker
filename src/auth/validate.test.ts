import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TEST_SECRET = "test-secret-key-for-hmac-validation";
const TEST_TASK_ID = "task-123";

describe("auth validation", () => {
  describe("generateAuthToken", () => {
    it("generates consistent tokens for same input", async () => {
      const { generateAuthToken } = await import("./validate.js");
      const token1 = generateAuthToken(TEST_SECRET, TEST_TASK_ID, 1000, 5000);
      const token2 = generateAuthToken(TEST_SECRET, TEST_TASK_ID, 1000, 5000);
      expect(token1).toBe(token2);
    });

    it("generates different tokens for different task IDs", async () => {
      const { generateAuthToken } = await import("./validate.js");
      const token1 = generateAuthToken(TEST_SECRET, "task-1", 1000, 5000);
      const token2 = generateAuthToken(TEST_SECRET, "task-2", 1000, 5000);
      expect(token1).not.toBe(token2);
    });

    it("generates different tokens for different issued_at", async () => {
      const { generateAuthToken } = await import("./validate.js");
      const token1 = generateAuthToken(TEST_SECRET, TEST_TASK_ID, 1000, 5000);
      const token2 = generateAuthToken(TEST_SECRET, TEST_TASK_ID, 2000, 5000);
      expect(token1).not.toBe(token2);
    });

    it("generates different tokens for different TTL", async () => {
      const { generateAuthToken } = await import("./validate.js");
      const token1 = generateAuthToken(TEST_SECRET, TEST_TASK_ID, 1000, 5000);
      const token2 = generateAuthToken(TEST_SECRET, TEST_TASK_ID, 1000, 10000);
      expect(token1).not.toBe(token2);
    });

    it("generates different tokens for different secrets", async () => {
      const { generateAuthToken } = await import("./validate.js");
      const token1 = generateAuthToken("secret-1", TEST_TASK_ID, 1000, 5000);
      const token2 = generateAuthToken("secret-2", TEST_TASK_ID, 1000, 5000);
      expect(token1).not.toBe(token2);
    });

    it("generates base64 encoded tokens", async () => {
      const { generateAuthToken } = await import("./validate.js");
      const token = generateAuthToken(TEST_SECRET, TEST_TASK_ID, 1000, 5000);
      expect(() => Buffer.from(token, "base64")).not.toThrow();
      expect(token.length).toBeGreaterThanOrEqual(32);
    });
  });

  describe("validateAuth - format validation (works in both modes)", () => {
    it("rejects null auth", async () => {
      const { validateAuth } = await import("./validate.js");
      const result = validateAuth(null, TEST_TASK_ID);
      expect(result).toEqual({ valid: false, reason: "invalid_format" });
    });

    it("rejects undefined auth", async () => {
      const { validateAuth } = await import("./validate.js");
      const result = validateAuth(undefined, TEST_TASK_ID);
      expect(result).toEqual({ valid: false, reason: "invalid_format" });
    });

    it("rejects empty object", async () => {
      const { validateAuth } = await import("./validate.js");
      const result = validateAuth({}, TEST_TASK_ID);
      expect(result).toEqual({ valid: false, reason: "invalid_format" });
    });

    it("rejects missing token", async () => {
      const { validateAuth } = await import("./validate.js");
      const result = validateAuth(
        { issued_at: Date.now(), ttl: 60000 },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "invalid_format" });
    });

    it("rejects token shorter than 32 characters", async () => {
      const { validateAuth } = await import("./validate.js");
      const result = validateAuth(
        { token: "short", issued_at: Date.now(), ttl: 60000 },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "invalid_format" });
    });

    it("rejects missing issued_at", async () => {
      const { validateAuth } = await import("./validate.js");
      const result = validateAuth(
        { token: "a".repeat(32), ttl: 60000 },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "invalid_format" });
    });

    it("rejects missing ttl", async () => {
      const { validateAuth } = await import("./validate.js");
      const result = validateAuth(
        { token: "a".repeat(32), issued_at: Date.now() },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "invalid_format" });
    });

    it("rejects non-positive ttl", async () => {
      const { validateAuth } = await import("./validate.js");
      const result = validateAuth(
        { token: "a".repeat(32), issued_at: Date.now(), ttl: 0 },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "invalid_format" });
    });

    it("rejects negative ttl", async () => {
      const { validateAuth } = await import("./validate.js");
      const result = validateAuth(
        { token: "a".repeat(32), issued_at: Date.now(), ttl: -1000 },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "invalid_format" });
    });
  });

  describe("validateAuth - freshness validation (works in both modes)", () => {
    it("rejects expired tokens", async () => {
      const { validateAuth, generateAuthToken } = await import("./validate.js");
      const issuedAt = Date.now() - 120000; // 2 minutes ago
      const ttl = 60000; // 1 minute TTL = expired 1 minute ago
      const token = generateAuthToken(TEST_SECRET, TEST_TASK_ID, issuedAt, ttl);
      const result = validateAuth(
        { token, issued_at: issuedAt, ttl },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "expired" });
    });

    it("accepts tokens just before expiry", async () => {
      const { validateAuth, generateAuthToken } = await import("./validate.js");
      const issuedAt = Date.now() - 59000; // 59 seconds ago
      const ttl = 60000; // 1 minute TTL = 1 second remaining
      const token = generateAuthToken(TEST_SECRET, TEST_TASK_ID, issuedAt, ttl);
      const result = validateAuth(
        { token, issued_at: issuedAt, ttl },
        TEST_TASK_ID,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("validateAuth - clock skew validation (works in both modes)", () => {
    it("rejects tokens issued too far in the future", async () => {
      const { validateAuth, generateAuthToken } = await import("./validate.js");
      const issuedAt = Date.now() + 10000; // 10 seconds in the future (> 5s tolerance)
      const ttl = 60000;
      const token = generateAuthToken(TEST_SECRET, TEST_TASK_ID, issuedAt, ttl);
      const result = validateAuth(
        { token, issued_at: issuedAt, ttl },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "issued_in_future" });
    });

    it("accepts tokens issued slightly in the future (within 5s tolerance)", async () => {
      const { validateAuth, generateAuthToken } = await import("./validate.js");
      const issuedAt = Date.now() + 3000; // 3 seconds in the future (< 5s tolerance)
      const ttl = 60000;
      const token = generateAuthToken(TEST_SECRET, TEST_TASK_ID, issuedAt, ttl);
      const result = validateAuth(
        { token, issued_at: issuedAt, ttl },
        TEST_TASK_ID,
      );
      expect(result.valid).toBe(true);
    });

    it("accepts tokens issued exactly at tolerance boundary", async () => {
      const { validateAuth, generateAuthToken } = await import("./validate.js");
      const issuedAt = Date.now() + 5000; // Exactly 5 seconds in the future
      const ttl = 60000;
      const token = generateAuthToken(TEST_SECRET, TEST_TASK_ID, issuedAt, ttl);
      const result = validateAuth(
        { token, issued_at: issuedAt, ttl },
        TEST_TASK_ID,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("validateAuth - local mode (skipAuthValidation=true)", () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doMock("../config.js", () => ({
        config: {
          skipAuthValidation: true,
        },
      }));
    });

    afterEach(() => {
      vi.doUnmock("../config.js");
      vi.resetModules();
    });

    it("skips HMAC validation and accepts any valid-format token", async () => {
      const { validateAuth } = await import("./validate.js");
      // Use a fake token that wouldn't pass HMAC validation
      const auth = {
        token: "a".repeat(44), // Valid length but wrong signature
        issued_at: Date.now(),
        ttl: 60000,
      };
      const result = validateAuth(auth, TEST_TASK_ID);
      expect(result).toEqual({ valid: true });
    });

    it("still validates format in local mode", async () => {
      const { validateAuth } = await import("./validate.js");
      const result = validateAuth(
        { token: "short", issued_at: Date.now(), ttl: 60000 },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "invalid_format" });
    });

    it("still validates freshness in local mode", async () => {
      const { validateAuth } = await import("./validate.js");
      const auth = {
        token: "a".repeat(44),
        issued_at: Date.now() - 120000,
        ttl: 60000,
      };
      const result = validateAuth(auth, TEST_TASK_ID);
      expect(result).toEqual({ valid: false, reason: "expired" });
    });
  });

  describe("validateAuth - Vercel mode (skipAuthValidation=false)", () => {
    beforeEach(() => {
      vi.resetModules();
      vi.stubEnv("L0_AUTH_SECRET", TEST_SECRET);
      vi.doMock("../config.js", () => ({
        config: {
          skipAuthValidation: false,
        },
      }));
    });

    afterEach(() => {
      vi.doUnmock("../config.js");
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("accepts valid HMAC signature", async () => {
      const { validateAuth, generateAuthToken } = await import("./validate.js");
      const issuedAt = Date.now();
      const ttl = 60000;
      const token = generateAuthToken(TEST_SECRET, TEST_TASK_ID, issuedAt, ttl);
      const result = validateAuth(
        { token, issued_at: issuedAt, ttl },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: true });
    });

    it("rejects invalid signature", async () => {
      const { validateAuth } = await import("./validate.js");
      const auth = {
        token: "invalid-token-that-is-at-least-32-chars-long",
        issued_at: Date.now(),
        ttl: 60000,
      };
      const result = validateAuth(auth, TEST_TASK_ID);
      expect(result).toEqual({ valid: false, reason: "invalid_signature" });
    });

    it("rejects token signed for different task ID", async () => {
      const { validateAuth, generateAuthToken } = await import("./validate.js");
      const issuedAt = Date.now();
      const ttl = 60000;
      const token = generateAuthToken(TEST_SECRET, "other-task", issuedAt, ttl);
      const result = validateAuth(
        { token, issued_at: issuedAt, ttl },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "invalid_signature" });
    });

    it("rejects tampered issued_at", async () => {
      const { validateAuth, generateAuthToken } = await import("./validate.js");
      const issuedAt = Date.now();
      const ttl = 60000;
      const token = generateAuthToken(TEST_SECRET, TEST_TASK_ID, issuedAt, ttl);
      // Tamper with issued_at
      const result = validateAuth(
        { token, issued_at: issuedAt + 1000, ttl },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "invalid_signature" });
    });

    it("rejects tampered ttl", async () => {
      const { validateAuth, generateAuthToken } = await import("./validate.js");
      const issuedAt = Date.now();
      const ttl = 60000;
      const token = generateAuthToken(TEST_SECRET, TEST_TASK_ID, issuedAt, ttl);
      // Tamper with TTL
      const result = validateAuth(
        { token, issued_at: issuedAt, ttl: ttl + 1000 },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "invalid_signature" });
    });

    it("rejects when L0_AUTH_SECRET is not set", async () => {
      vi.unstubAllEnvs(); // Remove the secret
      vi.resetModules();
      vi.doMock("../config.js", () => ({
        config: {
          skipAuthValidation: false,
        },
      }));

      const { validateAuth, generateAuthToken } = await import("./validate.js");
      const issuedAt = Date.now();
      const ttl = 60000;
      // Generate with secret, but secret won't be available during validation
      const token = generateAuthToken(TEST_SECRET, TEST_TASK_ID, issuedAt, ttl);
      const result = validateAuth(
        { token, issued_at: issuedAt, ttl },
        TEST_TASK_ID,
      );
      expect(result).toEqual({ valid: false, reason: "missing_auth_secret" });
    });
  });
});
