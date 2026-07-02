import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { DomainError } from './events.js';

export type AppRateLimitConfig = false | { max?: number; loginMax?: number } | undefined;

export async function installAppHttp(app: FastifyInstance, rateLimit: AppRateLimitConfig): Promise<void> {
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 },
  });

  if (rateLimit !== false) {
    await app.register(fastifyRateLimit, {
      max: rateLimit?.max ?? 600,
      timeWindow: '1 minute',
      // Internal service routes (Centaur node-sync capture/changes polling) are
      // authenticated by their own bearer key and arrive from a single gateway
      // IP — sharing the per-IP browser bucket both throttles capture traffic
      // (observed live: /api/internal capture 429s) and lets that traffic
      // exhaust the bucket for real clients behind the same NAT.
      allowList: (req) => req.url.startsWith('/api/internal/'),
      errorResponseBuilder: (_req, context) => ({
        statusCode: context.statusCode,
        error: 'rate_limited',
        message: `rate limit exceeded, retry in ${context.after}`,
      }),
    });
  }

  // CORS for allowlisted cross-origin clients (the Electron desktop shell at
  // app://atrium uses an absolute origin + bearer token). The web SPA is
  // same-origin and never sends an Origin header here. Token auth carries no
  // cookies, so we echo only allowlisted origins and omit allow-credentials.
  const corsOrigins = new Set(config.corsOrigins);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !corsOrigins.has(origin)) return;
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    reply.header('access-control-allow-headers', 'authorization, content-type');
    reply.header('access-control-max-age', '600');
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
      return reply;
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const error = err as { statusCode?: number; message?: unknown };
    if (error.statusCode === 429) {
      return reply.code(429).send({
        error: 'rate_limited',
        message: typeof error.message === 'string' && error.message.length > 0 ? error.message : 'rate limit exceeded',
      });
    }
    app.log.error(err);
    const status = error.statusCode ?? 500;
    return reply.code(status).send({ error: 'internal', message: 'internal error' });
  });
}
