import type { VercelRequest, VercelResponse } from "@vercel/node";
import { TaskReplayRequestSchema } from "../src/events/inbound.js";
import { validateAuth } from "../src/auth/index.js";
import { getWorkerInstance } from "../src/worker-instance.js";

/**
 * POST /api/replay
 *
 * Replay recorded events for a task.
 * Re-emits already-recorded facts - does NOT re-execute.
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
  const parseResult = TaskReplayRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: "Invalid request",
      details: parseResult.error.format(),
    });
    return;
  }

  const replayRequest = parseResult.data;

  // Validate auth (ephemeral, single-invocation)
  const authResult = validateAuth(replayRequest.auth);
  if (!authResult.valid) {
    res.status(401).json({
      error: "Auth validation failed",
      reason: authResult.reason,
    });
    return;
  }

  // Get worker instance
  const worker = getWorkerInstance();
  if (!worker) {
    res.status(503).json({ error: "Worker not initialized" });
    return;
  }

  // Check if task exists in event store
  const canReplay = await worker.canReplay(replayRequest.task_id);
  if (!canReplay) {
    res.status(404).json({
      error: "Task not found",
      task_id: replayRequest.task_id,
    });
    return;
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Replay events
  try {
    const result = await worker.replay(replayRequest, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Send replay summary
    res.write(
      `data: ${JSON.stringify({
        type: "REPLAY_COMPLETE",
        events_replayed: result.eventsReplayed,
        output_hash_match: result.outputHashMatch,
      })}\n\n`,
    );

    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.write(`data: ${JSON.stringify({ type: "ERROR", message })}\n\n`);
    res.end();
  }
}
