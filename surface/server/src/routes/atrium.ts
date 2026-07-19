import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import type { UserRef } from '../events.js';
import { getObjectBytes } from '../s3.js';
import { ensureSessionCapabilitySnapshots } from '../session-capabilities.js';

export interface AtriumRouteDeps {
  pool: Db;
  requireSessionAccess(req: FastifyRequest, reply: FastifyReply): Promise<UserRef | null>;
}

export function registerAtriumRoutes(app: FastifyInstance, deps: AtriumRouteDeps): void {
  const { pool, requireSessionAccess } = deps;

  app.get('/api/sessions/:id/atrium/capabilities', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const snapshots = await ensureSessionCapabilitySnapshots(pool, { getObjectBytes }, id);
    return reply.type('application/json').send({ sessionId: id, snapshots });
  });
}
