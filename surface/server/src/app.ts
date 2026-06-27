import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { Db } from './db.js';
import { clearReceiptTimers } from './push.js';
import type { SessionRuns } from './session-runs.js';
import { createAppAccessContext } from './app-access.js';
import { installAppAuth } from './app-auth.js';
import { type AppRateLimitConfig, installAppHttp } from './app-http.js';
import { createAppMutationContext } from './app-mutations.js';
import { createAppServices, type AppServiceDeps } from './app-services.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerAtriumRoutes } from './routes/atrium.js';
import { registerCallRoutes } from './routes/calls.js';
import { registerChannelArtifactWritebackRoutes } from './routes/channel-artifact-writeback.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerEntryRoutes } from './routes/entries.js';
import { registerFileRoutes } from './routes/files.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInternalArtifactRoutes } from './routes/internal-artifacts.js';
import { registerInternalAtriumRoutes } from './routes/internal-atrium.js';
import { registerInternalSessionRuntimeRoutes } from './routes/internal-session-runtime.js';
import { registerInternalWarmcacheRoutes } from './routes/internal-warmcache.js';
import { registerMeRoutes } from './routes/me.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerPushRoutes } from './routes/push.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSessionInteractionRoutes } from './routes/session-interactions.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerWebsocketRoutes } from './routes/websocket.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

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
  /** Internal x-api-key override for tests; production reads config. */
  artifactCaptureApiKey?: AppServiceDeps['artifactCaptureApiKey'];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool } = deps;
  const {
    agentProfiles,
    appRegistry,
    artifactCaptureApiKey,
    calls,
    emailFetch,
    fileStorage,
    hub,
    providerCredentials,
    secret,
    sessionRuns,
    voip,
  } = createAppServices(deps);
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  const rateLimit = deps.rateLimit;
  await installAppHttp(app, rateLimit);

  const { rawSession, userFromSession, userFromRequest, requireUser } = installAppAuth(app, {
    pool,
    secret,
    sessionCookie: config.sessionCookie,
  });
  const { optionalOpId, runMutation } = createAppMutationContext(pool);
  const {
    activeWorkspaceIdFor,
    canViewFull,
    fullViewForbidden,
    noWorkspace,
    requireCaptureKey,
    requireSessionAccess,
    resolveInternalSessionRef,
    serializeArtifactRoots,
    sessionArtifactAccess,
  } = createAppAccessContext({
    artifactCaptureApiKey,
    fullViewEnabled: config.fullViewEnabled,
    pool,
    requireUser,
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
            const user = req.user ?? (await userFromRequest(req));
            return user?.id ?? 'anonymous';
          },
        };

  registerAuthRoutes(app, {
    pool,
    secret,
    callsConfigured: calls !== null,
    rateLimit,
    emailFetch,
    rawSession,
    requireUser,
  });

  registerMeRoutes(app, {
    hub,
    requireUser,
    optionalOpId,
    runMutation,
    providerCredentials,
    agentProfiles,
    sessionRuns,
  });

  // -------------------------------------------------------------------------
  // Workspaces & channels
  // -------------------------------------------------------------------------

  registerWorkspaceRoutes(app, { pool, requireUser });

  registerChannelRoutes(app, {
    pool,
    hub,
    requireUser,
    optionalOpId,
    runMutation,
    activeWorkspaceIdFor,
    noWorkspace,
  });

  registerSyncRoutes(app, { pool, requireUser });

  registerCallRoutes(app, { pool, hub, calls, voip, requireUser, optionalOpId, runMutation });
  registerMessageRoutes(app, { pool, hub, stt: deps.stt, requireUser, optionalOpId, runMutation });
  registerEntryRoutes(app, {
    pool,
    hub,
    entryAnnotationRateLimit,
    requireUser,
    optionalOpId,
    canViewFull,
    fullViewForbidden,
    runMutation,
  });
  registerUploadRoutes(app, { pool, fileStorage, secret, requireUser, activeWorkspaceIdFor, noWorkspace });

  await registerChannelArtifactWritebackRoutes(app, { pool, maxUploadBytes: config.maxUploadBytes, requireUser });

  registerSessionRoutes(app, {
    pool,
    sessionRuns,
    agentProfiles,
    appRegistry,
    requireUser,
    requireSessionAccess,
    optionalOpId,
    runMutation,
  });

  await registerFileRoutes(app, {
    pool,
    requireSessionAccess,
    sessionArtifactAccess,
    serializeArtifactRoots,
  });

  await registerArtifactRoutes(app, {
    pool,
    sessionRuns,
    requireSessionAccess,
    sessionArtifactAccess,
    serializeArtifactRoots,
  });

  registerAtriumRoutes(app, {
    pool,
    requireUser,
    requireSessionAccess,
    canViewFull,
    fullViewForbidden,
  });

  await registerInternalArtifactRoutes(app, {
    pool,
    maxUploadBytes: config.maxUploadBytes,
    requireCaptureKey,
    resolveInternalSessionRef,
    sessionArtifactAccess,
    serializeArtifactRoots,
  });

  registerInternalAtriumRoutes(app, {
    pool,
    sessionRuns,
    requireCaptureKey,
    canViewFull,
    fullViewForbidden,
  });

  await registerInternalWarmcacheRoutes(app, {
    pool,
    requireCaptureKey,
    resolveInternalSessionRef,
  });

  await registerInternalSessionRuntimeRoutes(app, {
    pool,
    maxUploadBytes: config.maxUploadBytes,
    agentProfiles,
    providerCredentials,
    requireCaptureKey,
    resolveInternalSessionRef,
  });

  registerSessionInteractionRoutes(app, {
    sessionRuns,
    maxMessageBytes: config.maxMessageBytes,
    requireUser,
    requireSessionAccess,
    optionalOpId,
    runMutation,
    publishEvent: (event) => hub.publishEvent(event),
  });

  registerPushRoutes(app, { pool, requireUser });
  registerHealthRoutes(app);

  registerWebsocketRoutes(app, { pool, hub, sessionRuns, userFromSession, userFromRequest });

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
