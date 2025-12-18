import type { VercelRequest, VercelResponse } from "@vercel/node";
import { TaskSubmitSchema } from "../src/events/inbound.js";
import { validateAuth } from "../src/auth/index.js";
import {
  createWorkerInstance,
  getWorkerInstance,
} from "../src/worker-instance.js";

/**
 * POST /api/submit
 *
 * Submit a task for execution.
 * Returns streaming SSE response with L0 events.
 *
 * Backpressure: If no slot available, returns 503 immediately.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Parse and validate request
  const parseResult = TaskSubmitSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: "Invalid request",
      details: parseResult.error.format(),
    });
    return;
  }

  const taskSubmit = parseResult.data;

  // Validate auth (ephemeral, single-invocation)
  const authResult = validateAuth(taskSubmit.auth, taskSubmit.task_id);
  if (!authResult.valid) {
    res.status(401).json({
      error: "Auth validation failed",
      reason: authResult.reason,
    });
    return;
  }

  // Get or create worker instance
  const worker = getWorkerInstance() ?? createWorkerInstance();

  // Check if worker is accepting
  if (!worker.isAccepting()) {
    res.status(503).json({
      error: "Worker not accepting tasks",
      state: worker.state,
    });
    return;
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Execute task and stream events
  // Slot acquisition happens atomically inside executeTaskWithEvents
  try {
    await worker.executeTaskWithEvents(taskSubmit, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    // Handle slot exhaustion with proper 503 response
    if (message === "No slots available") {
      res.write(
        `data: ${JSON.stringify({
          type: "ERROR",
          code: "NO_SLOTS",
          message,
          inflight: worker.inflightCount,
          max: worker.maxConcurrency,
        })}\n\n`,
      );
    } else {
      res.write(`data: ${JSON.stringify({ type: "ERROR", message })}\n\n`);
    }
    res.end();
  }
}
