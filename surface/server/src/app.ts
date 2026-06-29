import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { Db } from './db.js';
import { clearReceiptTimers } from './push.js';
import type { SessionRuns } from './session-runs.js';
import { createAppAccessContext } from './app-access.js';
import { installAppAuth } from './app-auth.js';
import { type AppRateLimitConfig, installAppHttp } from './app-http.js';
import { createAppMutationContext } from './app-mutations.js';
import { registerAppRoutes } from './app-routes.js';
import { createAppServices, type AppServiceDeps } from './app-services.js';
import { installServerTelemetry } from './telemetry.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The session runtime, exposed for tests and operational hooks. */
    sessionRuns: SessionRuns;
  }
}

export interface AppDeps {
  pool: Db;
  hub?: AppServiceDeps['hub'];
  sessionSecret?: AppServiceDeps['sessionSecret'];
  sessionRuns?: AppServiceDeps['sessionRuns'];
  rateLimit?: AppRateLimitConfig;
  fileStorage?: AppServiceDeps['fileStorage'];
  stt?: {
    enqueue(): void;
  };
  /** Injectable in tests; false keeps call endpoints explicitly unconfigured. */
  calls?: AppServiceDeps['calls'];
  /** Injectable in tests; defaults to env-selected APNs/FCM/noop transport. */
  voip?: AppServiceDeps['voip'];
  /** Injectable fetch for the email transport (tests mock Resend). */
  emailFetch?: AppServiceDeps['emailFetch'];
  /** Injectable iron-control client for connection convergence tests. */
  ironControl?: AppServiceDeps['ironControl'];
  /** Internal x-api-key override for tests; production reads config. */
  artifactCaptureApiKey?: AppServiceDeps['artifactCaptureApiKey'];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool } = deps;
  const services = createAppServices(deps);
  const { artifactCaptureApiKey, secret, sessionRuns } = services;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
  await installServerTelemetry(app);

  const rateLimit = deps.rateLimit;
  await installAppHttp(app, rateLimit);

  const auth = installAppAuth(app, {
    pool,
    secret,
    sessionCookie: config.sessionCookie,
  });
  const mutation = createAppMutationContext(pool);
  const access = createAppAccessContext({
    artifactCaptureApiKey,
    fullViewEnabled: config.fullViewEnabled,
    pool,
    requireUser: auth.requireUser,
    sessionRuns,
  });

  const entryAnnotationRateLimit =
    rateLimit === false
      ? false
      : {
          max: 30,
          timeWindow: '1 minute',
          hook: 'preHandler' as const,
          keyGenerator: async (req: FastifyRequest) => {
            const user = req.user ?? (await auth.userFromRequest(req));
            return user?.id ?? 'anonymous';
          },
        };

  await registerAppRoutes({
    access,
    app,
    auth,
    entryAnnotationRateLimit,
    mutation,
    pool,
    rateLimit,
    services,
    stt: deps.stt,
  });

  app.addHook('onReady', async () => {
    await sessionRuns.resumeActiveSessions();
  });
  app.addHook('onClose', async () => {
    clearReceiptTimers();
    await sessionRuns.close();
  });

  app.decorate('sessionRuns', sessionRuns);

  return app;
}
