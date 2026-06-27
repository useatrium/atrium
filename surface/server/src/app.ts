import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { verifySession } from './cookie.js';
import { DomainError, canAccessChannel, type UserRef } from './events.js';
import { workspaceIdsFor } from './membership.js';
import { WsHub } from './hub.js';
import { clearReceiptTimers } from './push.js';
import { deleteObject, ensureBucket, getObjectBytes, headObject, presignGet, presignPut, uploadObject } from './s3.js';
import { SessionRuns, type SessionRunsOptions } from './session-runs.js';
import { writeBackArtifact } from './artifact-writeback.js';
import { readableArtifactRootsForSession, type ArtifactScopeRoot } from './artifact-scope.js';
import { canonicalizeRouteArtifactPath, firstHeader, normalizeMime, parseBaseSeq } from './artifact-route-utils.js';
import { isUuid, withIdempotency } from './idempotency.js';
import type { CallTokenService } from './livekit.js';
import { createLiveKitTokenService } from './livekit.js';
import { getVoipSender, type VoipPushSender } from './voip.js';
import { CentaurClient } from '@atrium/centaur-client';
import { ProviderCredentials } from './provider-credentials.js';
import { AgentProfiles } from './agent-profiles.js';
import { DemoCentaurClient } from './demo-centaur.js';
import { AppRegistry } from './app-registry.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerAtriumRoutes } from './routes/atrium.js';
import { registerCallRoutes } from './routes/calls.js';
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
import { registerWorkspaceRoutes } from './routes/workspaces.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRef | null;
  }
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

  async function userFromSession(raw: string | undefined | null): Promise<UserRef | null> {
    const sessionId = verifySession(raw, secret);
    if (!sessionId) return null;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
    const res = await pool.query<{
      id: string;
      handle: string;
      display_name: string;
      expires_at: Date;
    }>(
      `SELECT u.id, u.handle, u.display_name, s.expires_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > now()`,
      [sessionId],
    );
    const row = res.rows[0];
    if (!row) return null;
    // Sliding renewal: active sessions never expire, idle ones die in 30d.
    if (new Date(row.expires_at).getTime() - Date.now() < 15 * 24 * 60 * 60 * 1000) {
      void pool
        .query(`UPDATE auth_sessions SET expires_at = now() + interval '30 days' WHERE id = $1`, [sessionId])
        .catch(() => {});
    }
    return { id: row.id, handle: row.handle, displayName: row.display_name };
  }

  /** Signed session value from the request: bearer header (native) or cookie (web). */
  function rawSession(req: FastifyRequest): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
    return req.cookies[config.sessionCookie];
  }

  function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  async function userFromRequest(req: FastifyRequest): Promise<UserRef | null> {
    return userFromSession(rawSession(req));
  }

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => {
    req.user = await userFromRequest(req);
  });

  function requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null {
    if (!req.user) {
      reply.code(401).send({ error: 'unauthorized', message: 'login required' });
      return null;
    }
    return req.user;
  }

  /** Full/raw view requires the deployment flag AND a per-user grant. Looked up
   * (not carried on UserRef) so raw_access never leaks into embedded user objects. */
  async function canViewFull(userId: string): Promise<boolean> {
    if (!config.fullViewEnabled) return false;
    const res = await pool.query<{ raw_access: boolean }>(`SELECT raw_access FROM users WHERE id = $1`, [userId]);
    return res.rows[0]?.raw_access === true;
  }

  function fullViewForbidden(reply: FastifyReply) {
    return reply.code(403).send({ error: 'full_view_forbidden' });
  }

  function optionalOpId(body: unknown): string | undefined {
    if (!isPlainObject(body) || body.opId == null) return undefined;
    if (!isUuid(body.opId)) {
      throw new DomainError(400, 'bad_request', 'opId must be a uuid');
    }
    return body.opId;
  }

  async function runMutation<T>(args: {
    userId: string;
    opId?: string;
    opType: string;
    body: unknown;
    fn: (client: DbClient) => Promise<T>;
    onApplied?: (response: T) => void | Promise<void>;
  }): Promise<T> {
    if (args.opId) {
      return withIdempotency(
        pool,
        { userId: args.userId, opId: args.opId, opType: args.opType, body: args.body },
        args.fn,
        { onApplied: args.onApplied },
      );
    }
    const response = await withTx(pool, args.fn);
    if (args.onApplied) await args.onApplied(response);
    return response;
  }

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

  async function activeWorkspaceIdFor(userId: string): Promise<string | null> {
    return (await workspaceIdsFor(pool, userId))[0] ?? null;
  }

  function noWorkspace(reply: FastifyReply) {
    return reply.code(403).send({ error: 'no_workspace', message: 'user has no workspace' });
  }

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

  // === writeback route ===
  await app.register(async (writeback) => {
    writeback.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.maxUploadBytes }, (_req, body, done) =>
      done(null, body),
    );

    writeback.put('/api/channels/:channelId/artifacts', async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      const { channelId } = req.params as { channelId: string };
      if (!(await canAccessChannel(pool, user.id, channelId))) {
        return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
      }

      const query = req.query as { path?: unknown; session?: unknown };
      const headerPath = firstHeader(req.headers['x-artifact-path']);
      const queryPath = typeof query.path === 'string' ? query.path.trim() : '';
      const path = (queryPath || headerPath?.trim() || '').trim();
      if (!path) {
        return reply.code(400).send({ error: 'bad_request', message: 'valid artifact path required' });
      }

      const sessionId = typeof query.session === 'string' ? query.session.trim() : '';
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
        return reply.code(400).send({ error: 'bad_request', message: 'session query parameter required' });
      }
      const session = await pool.query<{ id: string }>(`SELECT id FROM sessions WHERE id = $1 AND channel_id = $2`, [
        sessionId,
        channelId,
      ]);
      if (!session.rows[0]) {
        return reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
      }
      const canonicalPath = canonicalizeRouteArtifactPath(reply, path, { sessionId, channelId });
      if (!canonicalPath) return;

      const body = Buffer.isBuffer(req.body)
        ? req.body
        : req.body instanceof Uint8Array
          ? Buffer.from(req.body)
          : Buffer.alloc(0);
      const mime = normalizeMime(firstHeader(req.headers['content-type']));
      const baseSeq = parseBaseSeq(firstHeader(req.headers['x-artifact-base-seq']));
      if (baseSeq === false) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
      }

      const result = await writeBackArtifact({
        pool,
        storage: { uploadObject, getObjectBytes, headObject },
        channelId,
        sessionId,
        path: canonicalPath,
        bytes: body,
        mime,
        author: `human:${user.id}`,
        ...(baseSeq == null ? {} : { baseSeq }),
      });
      if (!result.ok) {
        return reply.code(409).send({
          error: result.reason === 'stale_base' ? 'stale_base' : result.reason,
          ...(result.baseSeq != null ? { baseSeq: result.baseSeq } : {}),
          ...(result.latestSeq != null ? { latestSeq: result.latestSeq } : {}),
        });
      }
      return reply.send({ seq: result.seq, status: result.status });
    });
  });

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

  async function resolveInternalSessionRef(
    sessionRef: string,
  ): Promise<{ id: string; channelId: string; workspaceId: string } | null> {
    const res = await pool.query<{ id: string; channel_id: string; workspace_id: string }>(
      `SELECT id, channel_id, workspace_id
         FROM sessions
        WHERE id::text = $1 OR centaur_thread_key = $1
        LIMIT 1`,
      [sessionRef],
    );
    const row = res.rows[0];
    return row ? { id: row.id, channelId: row.channel_id, workspaceId: row.workspace_id } : null;
  }

  async function sessionArtifactAccess(sessionId: string, userId?: string | null) {
    return readableArtifactRootsForSession(pool, sessionId, userId);
  }

  function serializeArtifactRoots(roots: readonly ArtifactScopeRoot[]) {
    return roots.map((root) => ({
      prefix: root.prefix,
      scope: root.kind,
      writable: root.writable,
    }));
  }

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

  // === internal node-sync ingestion (x-api-key; the node daemon is trusted infra,
  // not a cookie-bearing user). Reuses the shipped write-back + serve + change-feed.
  const requireCaptureKey = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const key = firstHeader(req.headers['x-api-key']);
    if (!artifactCaptureApiKey || key !== artifactCaptureApiKey) {
      reply.code(401).send({ error: 'unauthorized', message: 'x-api-key required' });
      return false;
    }
    return true;
  };

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

  // Every session sub-resource is channel-access gated (404, like
  // getSessionForUser) so a guessed session id in a private/DM channel can't
  // be steered, seat-hijacked, or cancelled by a non-member.
  async function requireSessionAccess(req: FastifyRequest, reply: FastifyReply): Promise<UserRef | null> {
    const user = requireUser(req, reply);
    if (!user) return null;
    const { id } = req.params as { id: string };
    if (!(await sessionRuns.userCanAccessSession(id, user.id))) {
      reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
      return null;
    }
    return user;
  }

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

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true, config: { rateLimit: false } }, (socket, req) => {
      // Handlers must attach synchronously: clients send subscribe/focus the
      // moment the socket opens, and frames that arrive while auth is still
      // awaiting the DB would otherwise be dropped on the floor (the client
      // would then sit on a "live" socket subscribed to nothing). Buffer
      // frames until auth resolves, then replay.
      let client: ReturnType<WsHub['addClient']> | null = null;
      const preAuth: Buffer[] = [];

      const handleMessage = (user: UserRef, raw: Buffer) => {
        if (!client) return;
        const c = client;
        let msg: { type?: string; channelIds?: unknown; channelId?: unknown; sessionId?: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'subscribe' && Array.isArray(msg.channelIds)) {
          const ids = msg.channelIds.filter((v): v is string => typeof v === 'string').slice(0, 500);
          // Member-only channels (and session: presence keys) drop ids the
          // user can't access so fanout/presence can trust subscriptions. A
          // session: key is gated on the session's channel — otherwise a
          // non-member could appear as a watcher of a foreign private session.
          void (async () => {
            const allowed: string[] = [];
            for (const id of ids) {
              const ok = id.startsWith('session:')
                ? await sessionRuns.userCanAccessSession(id.slice('session:'.length), user.id)
                : await canAccessChannel(pool, user.id, id);
              if (ok) allowed.push(id);
            }
            hub.subscribe(c, allowed);
          })().catch(() => {});
        } else if (msg.type === 'focus') {
          const channelId = typeof msg.channelId === 'string' ? msg.channelId : null;
          if (!channelId) {
            hub.setFocus(c, null);
          } else {
            void canAccessChannel(pool, user.id, channelId)
              .then((ok) => {
                if (ok) hub.setFocus(c, channelId);
              })
              .catch(() => {});
          }
        } else if (msg.type === 'typing') {
          // Session typing fans out over the `session:<id>` subscription
          // (relaySessionTyping re-checks the sender is watching it); otherwise
          // it's channel typing, gated on focus (access-checked) so nobody can
          // signal into a DM they aren't reading.
          if (typeof msg.sessionId === 'string') {
            hub.relaySessionTyping(c, msg.sessionId);
          } else if (typeof msg.channelId === 'string' && c.focusedChannelId === msg.channelId) {
            hub.relayTyping(c, msg.channelId);
          }
        } else if (msg.type === 'ping') {
          hub.sendTo(c, { type: 'pong', t: Date.now() });
        }
      };

      let authedUser: UserRef | null = null;
      socket.on('message', (raw: Buffer) => {
        if (authedUser) handleMessage(authedUser, raw);
        else preAuth.push(raw);
      });
      socket.on('pong', () => {
        if (client) client.isAlive = true;
      });
      const cleanup = () => {
        if (client) hub.removeClient(client);
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);

      void (async () => {
        // Browsers authenticate the upgrade with the session cookie; native
        // clients can't set headers on WebSocket, so accept ?token= too.
        const q = (req.query ?? {}) as { token?: unknown };
        const user =
          (typeof q.token === 'string' ? await userFromSession(q.token) : null) ??
          (await userFromRequest(req as FastifyRequest));
        if (!user) {
          socket.close(4401, 'unauthorized');
          return;
        }
        if (socket.readyState !== socket.OPEN) return; // closed while authing
        client = hub.addClient(socket, user);
        authedUser = user;
        for (const raw of preAuth.splice(0)) handleMessage(user, raw);
      })().catch(() => socket.close(1011, 'auth error'));
    });
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
