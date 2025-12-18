import type { VercelRequest, VercelResponse } from "@vercel/node";
import { WorkerConfigUpdateSchema } from "../src/events/inbound.js";
import { getWorkerInstance } from "../src/worker-instance.js";

/**
 * POST /api/config
 *
 * Hot-update worker configuration.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Parse and validate request
  const parseResult = WorkerConfigUpdateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parseResult.error.format(),
    });
  }

  const configUpdate = parseResult.data;

  // Get worker instance
  const worker = getWorkerInstance();
  if (!worker) {
    return res.status(503).json({ error: "Worker not initialized" });
  }

  // Verify worker ID matches
  if (configUpdate.worker_id !== worker.workerId) {
    return res.status(400).json({ error: "Worker ID mismatch" });
  }

  // Apply config update
  worker.updateConfig({
    maxConcurrency: configUpdate.max_concurrency,
    resourceCaps: configUpdate.resource_caps,
    featureFlags: configUpdate.feature_flags,
  });

  return res.status(200).json({
    success: true,
    max_concurrency: worker.maxConcurrency,
    timestamp: Date.now(),
  });
}
