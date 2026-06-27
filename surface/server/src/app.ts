import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import type { Db } from './db.js';
import { DomainError } from './events.js';
import { WsHub } from './hub.js';
import { clearReceiptTimers } from './push.js';
import { deleteObject, ensureBucket, getObjectBytes, presignGet, presignPut } from './s3.js';
import { SessionRuns, type SessionRunsOptions } from './session-runs.js';
import type { CallTokenService } from './livekit.js';
import { createLiveKitTokenService } from './livekit.js';
import { getVoipSender, type VoipPushSender } from './voip.js';
import { CentaurClient } from '@atrium/centaur-client';
import { ProviderCredentials } from './provider-credentials.js';
import { AgentProfiles } from './agent-profiles.js';
import { DemoCentaurClient } from './demo-centaur.js';
import { AppRegistry } from './app-registry.js';
import { createAppAccessContext } from './app-access.js';
import { installAppAuth } from './app-auth.js';
import { createAppMutationContext } from './app-mutations.js';
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
  hub?: WsHub;
  sessionSecret?: string;
  sessionRuns?: SessionRunsOptions;
  rateLimit?: false | { max?: number; loginMax?: number };
  fileStorage?: {
    ensureBucket: typeof ensureBucket;
    deleteObject: typeof deleteObject;
    presignGet: typeof presignGet;
    presignPut: typeof presignPut;
  };
  stt?: {
    enqueue(): void;
  };
  /** Injectable in tests; false keeps call endpoints explicitly unconfigured. */
  calls?: false | CallTokenService;
  /** Injectable in tests; defaults to env-selected APNs/FCM/noop transport. */
  voip?: VoipPushSender;
  /** Injectable fetch for the email transport (tests mock Resend). */
  emailFetch?: typeof fetch;
  /** Internal x-api-key override for tests; production reads config. */
  artifactCaptureApiKey?: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool } = deps;
  const hub = deps.hub ?? new WsHub();
  const secret = deps.sessionSecret ?? config.sessionSecret;
  const fileStorage = deps.fileStorage ?? { deleteObject, ensureBucket, presignGet, presignPut };
  const emailFetch = deps.emailFetch;
  const providerCredentials = new ProviderCredentials(pool, config.providerCredentialSecret);
  const agentProfiles = new AgentProfiles(pool);
  const sessionRunOptions = deps.sessionRuns ?? {};
  const centaur =
    sessionRunOptions.centaur ??
    new CentaurClient({
      baseUrl: sessionRunOptions.baseUrl ?? config.centaurBaseUrl,
      apiKey: sessionRunOptions.apiKey ?? config.centaurApiKey,
    });
  const sessionRuns = new SessionRuns(pool, hub, {
    ...sessionRunOptions,
    centaur: new DemoCentaurClient(centaur),
    providerCredentials,
    agentProfiles,
  });
  const calls = deps.calls === false ? null : (deps.calls ?? createLiveKitTokenService(config));
  const voip = deps.voip ?? getVoipSender(config);
  const artifactCaptureApiKey = deps.artifactCaptureApiKey ?? config.artifactCaptureApiKey;
  const appRegistry = new AppRegistry(pool, {
    appsOrigin: config.appsOrigin,
    signingSecret: config.appSigningSecret,
    launchTtlSeconds: config.appsLaunchTtlSeconds,
    storage: { getObjectBytes },
  });
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 },
  });

  const rateLimit = deps.rateLimit;
  if (rateLimit !== false) {
    await app.register(fastifyRateLimit, {
      max: rateLimit?.max ?? 600,
      timeWindow: '1 minute',
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
