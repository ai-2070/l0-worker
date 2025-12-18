import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getWorkerInstance,
  createWorkerInstance,
} from "../src/worker-instance.js";

/**
 * GET /api/status
 *
 * Get worker status (equivalent to WORKER_READY + WORKER_LOAD).
 */
export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Get or create worker instance
  const worker = getWorkerInstance() ?? createWorkerInstance();

  const status = {
    worker_id: worker.workerId,
    state: worker.state,
    protocol_version: worker.protocolVersion,
    max_concurrency: worker.maxConcurrency,
    inflight_tasks: worker.inflightCount,
    available_slots: worker.availableSlots,
    timestamp: Date.now(),
  };

  res.status(200).json(status);
}
