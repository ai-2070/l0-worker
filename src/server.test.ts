/**
 * Tests for server endpoint authentication and authorization.
 *
 * These tests verify:
 * - Localhost requests to /api/config work without auth
 * - Authenticated requests work
 * - JSON parsing errors return 400
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { generateAuthToken } from "./auth/validate.js";

const TEST_PORT = 4100;
const TEST_SECRET = "test-secret-for-config-endpoint";
let serverProcess: ChildProcess | null = null;
let workerId: string;

// Helper to wait for server to be ready
async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

// Helper to create a valid config update payload
function createConfigPayload(wid: string, withAuth = false) {
  const payload: Record<string, unknown> = {
    type: "WORKER_CONFIG_UPDATE",
    worker_id: wid,
    max_concurrency: 32,
    effective_ts: Date.now(),
  };

  if (withAuth) {
    const issuedAt = Date.now();
    const ttl = 60000;
    payload.auth = {
      token: generateAuthToken(TEST_SECRET, wid, issuedAt, ttl),
      issued_at: issuedAt,
      ttl,
    };
  }

  return payload;
}

// Start server once for all tests
beforeAll(async () => {
  // Start the server as a subprocess
  serverProcess = spawn("bun", ["run", "./src/server.ts"], {
    env: {
      ...process.env,
      PORT: TEST_PORT.toString(),
      L0_AUTH_SECRET: TEST_SECRET,
    },
    stdio: "pipe",
  });

  // Wait for server to be ready
  const ready = await waitForServer(TEST_PORT);
  if (!ready) {
    throw new Error("Server failed to start");
  }

  // Get the worker ID from status endpoint
  const statusResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`);
  const status = (await statusResponse.json()) as { workerId: string };
  workerId = status.workerId;
});

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

describe("Server: /api/config endpoint", () => {
  describe("localhost requests", () => {
    it("allows config update without auth from localhost", async () => {
      const payload = createConfigPayload(workerId, false);

      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as { success: boolean; maxConcurrency: number };
      expect(result.success).toBe(true);
      expect(result.maxConcurrency).toBe(32);
    });

    it("allows config update with auth from localhost", async () => {
      const payload = createConfigPayload(workerId, true);

      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as { success: boolean };
      expect(result.success).toBe(true);
    });
  });

  describe("request validation", () => {
    it("returns 400 for invalid JSON on /api/config", async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });

      expect(response.status).toBe(400);
      const result = (await response.json()) as { error: string };
      expect(result.error).toBe("Invalid JSON");
    });

    it("returns 400 for invalid request schema", async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: "payload" }),
      });

      expect(response.status).toBe(400);
      const result = (await response.json()) as { error: string };
      expect(result.error).toBe("Invalid request");
    });

    it("returns 400 for worker ID mismatch", async () => {
      const payload = createConfigPayload("wrong-worker-id", false);

      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      const result = (await response.json()) as { error: string };
      expect(result.error).toBe("Worker ID mismatch");
    });
  });

  describe("authenticated requests", () => {
    it("accepts valid auth token from localhost", async () => {
      const payload = createConfigPayload(workerId, true);

      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
    });

    it("succeeds with expired auth token from localhost (auth not required)", async () => {
      // Expired token - but since we're on localhost, auth is not required
      const issuedAt = Date.now() - 120000; // 2 minutes ago
      const ttl = 60000; // 1 minute TTL = expired

      const payload: Record<string, unknown> = {
        type: "WORKER_CONFIG_UPDATE",
        worker_id: workerId,
        max_concurrency: 32,
        effective_ts: Date.now(),
        auth: {
          token: generateAuthToken(TEST_SECRET, workerId, issuedAt, ttl),
          issued_at: issuedAt,
          ttl,
        },
      };

      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      // Since we're on localhost, auth is not required and the request succeeds
      expect(response.status).toBe(200);
    });
  });
});

describe("Server: JSON parsing errors", () => {
  it("returns 400 for invalid JSON on /api/submit", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(response.status).toBe(400);
    const result = (await response.json()) as { error: string };
    expect(result.error).toBe("Invalid JSON");
  });

  it("returns 400 for invalid JSON on /api/replay", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(response.status).toBe(400);
    const result = (await response.json()) as { error: string };
    expect(result.error).toBe("Invalid JSON");
  });

  it("returns 400 for invalid JSON on /api/config", async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{malformed json",
    });

    expect(response.status).toBe(400);
    const result = (await response.json()) as { error: string };
    expect(result.error).toBe("Invalid JSON");
  });
});
