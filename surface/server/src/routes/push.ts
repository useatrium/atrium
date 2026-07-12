import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Schema } from 'effect';
import { config } from '../config.js';
import type { Db } from '../db.js';
import type { UserRef } from '../events.js';
import { decodeRouteBody } from '../route-schema.js';
import type { WebPushSubscription } from '../webpush.js';

export interface PushRouteDeps {
  pool: Db;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

type PushPlatform = 'ios' | 'android' | 'web';
type PushKind = 'expo' | 'voip' | 'webpush';

const RegisterPushBodySchema = Schema.Struct({
  token: Schema.String,
  platform: Schema.optional(Schema.Unknown),
  kind: Schema.optional(Schema.Unknown),
  subscription: Schema.optional(Schema.Unknown),
});

const UnregisterPushBodySchema = Schema.Struct({
  token: Schema.String,
});

export function registerPushRoutes(app: FastifyInstance, deps: PushRouteDeps): void {
  const { pool, requireUser } = deps;

  app.get('/api/push/vapid-public-key', async () => ({ key: config.vapidPublicKey || null }));

  app.post('/api/push/register', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(RegisterPushBodySchema, req.body, { message: 'token required' });
    const token = body.token.trim();
    const platform = pushPlatformOrDefault(body.platform);
    const kind = body.kind == null ? 'expo' : body.kind;
    const maxTokenLength = kind === 'webpush' ? 4096 : 200;
    if (!token || token.length > maxTokenLength) {
      return reply.code(400).send({ error: 'bad_request', message: 'token required' });
    }
    if (!isPushKind(kind)) {
      return reply.code(400).send({ error: 'bad_request', message: 'kind must be expo, voip, or webpush' });
    }
    let subscription: WebPushSubscription | null = null;
    if (kind === 'webpush') {
      const raw = body.subscription;
      if (!isWebPushSubscription(raw)) {
        return reply.code(400).send({ error: 'bad_request', message: 'valid webpush subscription required' });
      }
      if (raw.endpoint !== token) {
        return reply.code(400).send({ error: 'bad_request', message: 'token must match subscription endpoint' });
      }
      if (platform !== 'web') {
        return reply.code(400).send({ error: 'bad_request', message: 'webpush platform must be web' });
      }
      subscription = raw;
    }
    // A device token follows whoever logged in last on that device.
    await pool.query(
      `INSERT INTO push_tokens (token, user_id, platform, kind, subscription) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           platform = EXCLUDED.platform,
           kind = EXCLUDED.kind,
           subscription = EXCLUDED.subscription`,
      [token, user.id, platform, kind, subscription],
    );
    return { ok: true };
  });

  app.post('/api/push/unregister', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(UnregisterPushBodySchema, req.body, { message: 'token required' });
    if (!body.token) {
      return reply.code(400).send({ error: 'bad_request', message: 'token required' });
    }
    await pool.query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [body.token, user.id]);
    return { ok: true };
  });
}

function pushPlatformOrDefault(value: unknown): PushPlatform {
  return value === 'android' || value === 'ios' || value === 'web' ? value : 'ios';
}

function isPushKind(value: unknown): value is PushKind {
  return value === 'expo' || value === 'voip' || value === 'webpush';
}

function isWebPushSubscription(value: unknown): value is WebPushSubscription {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof raw.endpoint !== 'string' || raw.endpoint.length > 4096) return false;
  let endpoint: URL;
  try {
    endpoint = new URL(raw.endpoint);
  } catch {
    return false;
  }
  if (endpoint.protocol !== 'https:') return false;
  return (
    typeof raw.keys === 'object' &&
    raw.keys !== null &&
    typeof raw.keys.p256dh === 'string' &&
    raw.keys.p256dh.length > 0 &&
    raw.keys.p256dh.length <= 512 &&
    typeof raw.keys.auth === 'string' &&
    raw.keys.auth.length > 0 &&
    raw.keys.auth.length <= 512
  );
}
