import type { VercelRequest, VercelResponse } from "@vercel/node";
import { WorkerConfigUpdateSchema } from "../src/events/inbound.js";
import { validateAuth } from "../src/auth/index.js";
import { getWorkerInstance } from "../src/worker-instance.js";

/**
 * POST /api/config
 *
 * Hot-update worker configuration.
 * Requires authentication (unlike standalone server which allows localhost without auth).
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

  // Validate auth - required for Vercel endpoint (no localhost exception)
  if (!configUpdate.auth) {
    return res.status(401).json({ error: "Auth required" });
  }
  const authResult = validateAuth(configUpdate.auth, configUpdate.worker_id);
  if (!authResult.valid) {
    return res.status(401).json({
      error: "Auth validation failed",
      reason: authResult.reason,
    });
  }

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
    maxConcurrency: worker.maxConcurrency,
    ts: Date.now(),
  });
}
