/**
 * Standalone HTTP server for desktop/local deployment.
 * Uses Bun's native server with SSE streaming support.
 *
 * Can be compiled to a single executable:
 *   bun build ./src/server.ts --compile --outfile dist/l0-worker
 */

import { TaskSubmitSchema, TaskReplayRequestSchema, WorkerConfigUpdateSchema } from "./events/inbound.js";
import { validateAuth } from "./auth/index.js";
import { createWorkerInstance } from "./worker-instance.js";
import { config } from "./config.js";

const port = Number(process.env.PORT) || 3000;
const startTime = Date.now();

// Create worker instance at startup
const worker = createWorkerInstance();

// Log startup mode
const mode = process.env.DEPLOYMENT === "vercel" || process.env.VERCEL ? "production" : "local";
const authStatus = config.skipAuthValidation ? "disabled" : "enabled";
console.log(`mode=${mode} auth=${authStatus}`);

/**
 * Handle POST /api/submit - Task execution with SSE streaming
 */
async function handleSubmit(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Parse and validate request
  const parseResult = TaskSubmitSchema.safeParse(body);
  if (!parseResult.success) {
    return Response.json(
      { error: "Invalid request", details: parseResult.error.format() },
      { status: 400 }
    );
  }

  const taskSubmit = parseResult.data;

  // Validate auth
  const authResult = validateAuth(taskSubmit.auth, taskSubmit.task_id);
  if (!authResult.valid) {
    return Response.json(
      { error: "Auth validation failed", reason: authResult.reason },
      { status: 401 }
    );
  }

  // Check if worker is accepting
  if (!worker.isAccepting()) {
    return Response.json(
      { error: "Worker not accepting tasks", state: worker.state },
      { status: 503 }
    );
  }

  // Early slot check
  if (!worker.hasAvailableSlot()) {
    return Response.json(
      { error: "No slots available", inflight: worker.inflightCount, max: worker.maxConcurrency },
      { status: 503 }
    );
  }

  // SSE streaming response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        await worker.executeTaskWithEvents(taskSubmit, (event) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        });

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";

        if (message === "No slots available") {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "ERROR",
            code: "NO_SLOTS",
            message,
            inflight: worker.inflightCount,
            max: worker.maxConcurrency,
          })}\n\n`));
        } else if (message === "Duplicate task ID") {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "ERROR",
            code: "DUPLICATE_TASK",
            message,
          })}\n\n`));
        } else {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "ERROR", message })}\n\n`));
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * Handle GET /api/status - Worker health check
 */
function handleStatus(): Response {
  const status = {
    workerId: worker.workerId,
    state: worker.state,
    protocolVersion: worker.protocolVersion,
    maxConcurrency: worker.maxConcurrency,
    inflight: worker.inflightCount,
    availableSlots: worker.availableSlots,
    uptimeMs: Date.now() - startTime,
    ts: Date.now(),
  };

  return Response.json(status);
}

/**
 * Handle POST /api/replay - Replay recorded events
 */
async function handleReplay(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Parse and validate request
  const parseResult = TaskReplayRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return Response.json(
      { error: "Invalid request", details: parseResult.error.format() },
      { status: 400 }
    );
  }

  const replayRequest = parseResult.data;

  // Validate auth
  const authResult = validateAuth(replayRequest.auth, replayRequest.task_id);
  if (!authResult.valid) {
    return Response.json(
      { error: "Auth validation failed", reason: authResult.reason },
      { status: 401 }
    );
  }

  // Check if task exists
  const canReplay = await worker.canReplay(replayRequest.task_id);
  if (!canReplay) {
    return Response.json(
      { error: "Task not found", task_id: replayRequest.task_id },
      { status: 404 }
    );
  }

  // SSE streaming response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        const result = await worker.replay(replayRequest, (event) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        });

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "REPLAY_COMPLETE",
          events_replayed: result.eventsReplayed,
          output_hash_match: result.outputHashMatch,
        })}\n\n`));

        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "ERROR", message })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * Check if request originates from localhost
 */
function isLocalhost(req: Request, server: { requestIP(req: Request): { address: string } | null }): boolean {
  const ip = server.requestIP(req);
  if (!ip) return false;
  const addr = ip.address;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * Handle POST /api/config - Hot configuration update
 * Allowed from localhost (no auth) or with valid auth from anywhere
 */
async function handleConfig(req: Request, server: { requestIP(req: Request): { address: string } | null }): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Parse and validate request
  const parseResult = WorkerConfigUpdateSchema.safeParse(body);
  if (!parseResult.success) {
    return Response.json(
      { error: "Invalid request", details: parseResult.error.format() },
      { status: 400 }
    );
  }

  const configUpdate = parseResult.data;

  // Allow localhost without auth, otherwise require valid auth
  if (!isLocalhost(req, server)) {
    if (!configUpdate.auth) {
      return Response.json({ error: "Auth required for non-localhost requests" }, { status: 401 });
    }
    const authResult = validateAuth(configUpdate.auth, configUpdate.worker_id);
    if (!authResult.valid) {
      return Response.json(
        { error: "Auth validation failed", reason: authResult.reason },
        { status: 401 }
      );
    }
  }

  // Verify worker ID matches
  if (configUpdate.worker_id !== worker.workerId) {
    return Response.json({ error: "Worker ID mismatch" }, { status: 400 });
  }

  // Apply config update
  worker.updateConfig({
    maxConcurrency: configUpdate.max_concurrency,
    resourceCaps: configUpdate.resource_caps,
    featureFlags: configUpdate.feature_flags,
  });

  return Response.json({
    success: true,
    maxConcurrency: worker.maxConcurrency,
    ts: Date.now(),
  });
}

/**
 * Main request router
 */
async function handleRequest(req: Request, server: { requestIP(req: Request): { address: string } | null }): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    // Route requests
    if (path === "/api/submit" && method === "POST") {
      return await handleSubmit(req);
    }

    if (path === "/api/status" && method === "GET") {
      return handleStatus();
    }

    if (path === "/api/replay" && method === "POST") {
      return await handleReplay(req);
    }

    if (path === "/api/config" && method === "POST") {
      return await handleConfig(req, server);
    }

    // Method not allowed for known paths
    if (["/api/submit", "/api/status", "/api/replay", "/api/config"].includes(path)) {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Not found
    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: "Internal server error", message }, { status: 500 });
  }
}

// Start the server
// @ts-expect-error Bun global is available at runtime when run with Bun
const server = Bun.serve({
  port,
  fetch: handleRequest,
});

// Emit structured ready signal for supervisor
const readySignal = {
  event: "worker.ready",
  port: server.port,
  workerId: worker.workerId,
};
console.log(JSON.stringify(readySignal));

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log(JSON.stringify({ event: "worker.draining", workerId: worker.workerId }));
  // Allow in-flight requests to complete
  setTimeout(() => {
    server.stop();
    process.exit(0);
  }, config.drainBufferMs);
});

process.on("SIGINT", () => {
  console.log(JSON.stringify({ event: "worker.draining", workerId: worker.workerId }));
  setTimeout(() => {
    server.stop();
    process.exit(0);
  }, config.drainBufferMs);
});
