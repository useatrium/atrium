import type { FastifyInstance } from 'fastify';
import { storageReady } from '../s3.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  // Storage gate (#215): once the boot bootstrap has started (storageReady()
  // non-null), health is red until the bucket check first succeeds — so a
  // health-gated deploy fails loudly on never-provisioned storage instead of
  // shipping a box that 500s every capture. Sticky after first success; app
  // builds that never start the bootstrap (tests, tooling) stay ungated.
  app.get('/healthz', { config: { rateLimit: false } }, async (_req, reply) => {
    if (storageReady() === false) {
      return reply.code(503).send({ ok: false, storage: 'unavailable' });
    }
    return { ok: true };
  });
}
