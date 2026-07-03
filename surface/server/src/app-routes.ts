import type { FastifyInstance } from 'fastify';
import type { AppAccessContext } from './app-access.js';
import type { AppAuthContext } from './app-auth.js';
import type { AppRateLimitConfig } from './app-http.js';
import type { AppMutationContext } from './app-mutations.js';
import type { AppServices } from './app-services.js';
import { config } from './config.js';
import type { Db } from './db.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerAtriumRoutes } from './routes/atrium.js';
import { registerCallRoutes } from './routes/calls.js';
import { registerChannelArtifactWritebackRoutes } from './routes/channel-artifact-writeback.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerClientErrorRoutes } from './routes/client-errors.js';
import type { EntryAnnotationRateLimit } from './routes/entries.js';
import { registerEntryRoutes } from './routes/entries.js';
import { registerFileRoutes } from './routes/files.js';
import { registerFilesHubRoutes } from './routes/files-hub.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInternalArtifactRoutes } from './routes/internal-artifacts.js';
import { registerInternalAtriumRoutes } from './routes/internal-atrium.js';
import { registerInternalChangesRoutes } from './routes/internal-changes.js';
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

export interface AppRouteDeps {
  access: AppAccessContext;
  app: FastifyInstance;
  auth: AppAuthContext;
  entryAnnotationRateLimit: EntryAnnotationRateLimit;
  mutation: AppMutationContext;
  pool: Db;
  rateLimit: AppRateLimitConfig;
  services: AppServices;
  stt?: {
    enqueue(): void;
  };
}

export async function registerAppRoutes(deps: AppRouteDeps): Promise<void> {
  const { access, app, auth, entryAnnotationRateLimit, mutation, pool, rateLimit, services, stt } = deps;
  const {
    agentProfiles,
    appRegistry,
    calls,
    emailFetch,
    fileStorage,
    hub,
    connections,
    ironControl,
    providerCredentials,
    secret,
    sessionRuns,
    voip,
  } = services;
  const { rawSession, requireUser, userFromRequest, userFromSession } = auth;
  const { optionalOpId, runMutation } = mutation;
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
  } = access;

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
    pool,
    requireUser,
    optionalOpId,
    runMutation,
    connections,
    ironControl,
    providerCredentials,
    agentProfiles,
    sessionRuns,
  });

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
  registerMessageRoutes(app, { pool, hub, stt, requireUser, optionalOpId, runMutation });
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
  await registerFilesHubRoutes(app, { pool, requireUser });

  await registerChannelArtifactWritebackRoutes(app, { pool, maxUploadBytes: config.maxUploadBytes, requireUser });

  registerSessionRoutes(app, {
    pool,
    sessionRuns,
    connections,
    ironControl,
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

  registerInternalChangesRoutes(app, {
    pool,
    hub,
    requireCaptureKey,
    resolveInternalSessionRef,
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
    pool,
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
  registerClientErrorRoutes(app, { pool, userFromRequest });

  registerWebsocketRoutes(app, { pool, hub, sessionRuns, userFromSession, userFromRequest });
}
