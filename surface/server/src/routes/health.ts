import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
}
