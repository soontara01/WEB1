import { Router } from 'express';
import type { MongoClient } from 'mongodb';

export interface Lifecycle {
  shuttingDown: boolean;
}

/**
 * Liveness and readiness probes for the load balancer / orchestrator.
 * On AKS with AGIC, the pod's readinessProbe (/readyz) also becomes the Application Gateway health probe.
 */
export function healthRouter(client: MongoClient, lifecycle: Lifecycle) {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (req, res) => {
    // Fail readiness first on shutdown so the gateway stops routing here before the server closes.
    if (lifecycle.shuttingDown) {
      res.status(503).json({ status: 'shutting-down' });
      return;
    }
    try {
      await client.db('admin').command({ ping: 1 });
      res.json({ status: 'ready' });
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  return router;
}
