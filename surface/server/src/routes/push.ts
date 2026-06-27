import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import type { UserRef } from '../events.js';

export interface PushRouteDeps {
  pool: Db;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

export function registerPushRoutes(app: FastifyInstance, deps: PushRouteDeps): void {
  const { pool, requireUser } = deps;

  app.post('/api/push/register', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { token?: unknown; platform?: unknown; kind?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const platform = body.platform === 'android' ? 'android' : 'ios';
    const kind = body.kind == null ? 'expo' : body.kind;
    if (!token || token.length > 200) {
      return reply.code(400).send({ error: 'bad_request', message: 'token required' });
    }
    if (kind !== 'expo' && kind !== 'voip') {
      return reply.code(400).send({ error: 'bad_request', message: 'kind must be expo or voip' });
    }
    // A device token follows whoever logged in last on that device.
    await pool.query(
      `INSERT INTO push_tokens (token, user_id, platform, kind) VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE
       SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, kind = EXCLUDED.kind`,
      [token, user.id, platform, kind],
    );
    return { ok: true };
  });

  app.post('/api/push/unregister', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { token?: unknown };
    if (typeof body.token !== 'string' || !body.token) {
      return reply.code(400).send({ error: 'bad_request', message: 'token required' });
    }
    await pool.query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [
      body.token,
      user.id,
    ]);
    return { ok: true };
  });
}
