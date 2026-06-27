import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { normalizePrefs } from '@atrium/surface-client/prefs';
import { config } from './config.js';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { verifySession } from './cookie.js';
import { DomainError, canAccessChannel, listChannelsFor, listVisibleSyncEvents, type UserRef } from './events.js';
import { workspaceIdsFor, workspaceMemberExists } from './membership.js';
import { WsHub } from './hub.js';
import { clearReceiptTimers } from './push.js';
import { deleteObject, ensureBucket, getObjectBytes, headObject, presignGet, presignPut, uploadObject } from './s3.js';
import {
  isHarness,
  loadHarnessStateBundle,
  loadHarnessTranscript,
  storeHarnessStateBundle,
  storeHarnessTranscript,
} from './harness-transcript.js';
import { SessionRuns, type SessionRunsOptions } from './session-runs.js';
import { writeBackArtifact } from './artifact-writeback.js';
import { readableArtifactRootsForSession, type ArtifactScopeRoot } from './artifact-scope.js';
import { canonicalizeRouteArtifactPath, firstHeader, normalizeMime, parseBaseSeq } from './artifact-route-utils.js';
import { isUuid, withIdempotency } from './idempotency.js';
import type { CallTokenService } from './livekit.js';
import { createLiveKitTokenService } from './livekit.js';
import { getVoipSender, type VoipPushSender } from './voip.js';
import { CentaurClient } from '@atrium/centaur-client';
import { CLAUDE_CODE_PROVIDER, CODEX_PROVIDER, ProviderCredentials } from './provider-credentials.js';
import { AgentProfiles } from './agent-profiles.js';
import {
  listSessionProfileBundles,
  loadProfileBundleBlob,
  MAX_PROFILE_BUNDLE_BLOB_BYTES,
  normalizeBundleSha,
  storeProfileBundleBlob,
} from './profile-bundles.js';
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
import { registerInternalWarmcacheRoutes } from './routes/internal-warmcache.js';
import { registerMeRoutes } from './routes/me.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerPushRoutes } from './routes/push.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSessionInteractionRoutes } from './routes/session-interactions.js';
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

  async function syncStateSnapshot(client: DbClient, userId: string) {
    const readRows = await client.query<{ channel_id: string; last_read_event_id: number }>(
      `SELECT rc.channel_id, rc.last_read_event_id
       FROM channel_read_cursors rc
       JOIN channels c ON c.id = rc.channel_id
       LEFT JOIN channel_members cm
         ON cm.channel_id = c.id AND cm.user_id = $1
       WHERE rc.user_id = $1
         AND ((c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$1')})
              OR cm.user_id IS NOT NULL)
       ORDER BY rc.channel_id ASC`,
      [userId],
    );
    const muteRows = await client.query<{ channel_id: string }>(
      `SELECT m.channel_id
       FROM channel_mutes m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN channel_members cm
         ON cm.channel_id = c.id AND cm.user_id = $1
       WHERE m.user_id = $1
         AND ((c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$1')})
              OR cm.user_id IS NOT NULL)
       ORDER BY m.channel_id ASC`,
      [userId],
    );
    const prefs = await client.query<{ prefs: unknown }>('SELECT prefs FROM users WHERE id = $1', [userId]);
    const draftRows = await client.query<{
      draft_key: string;
      text: string;
      updated_at: Date;
      deleted_at: Date | null;
    }>(
      `SELECT draft_key, text, updated_at, deleted_at
       FROM user_drafts
       WHERE user_id = $1
       ORDER BY draft_key ASC`,
      [userId],
    );
    const readCursors: Record<string, number> = {};
    for (const row of readRows.rows) readCursors[row.channel_id] = Number(row.last_read_event_id);
    const drafts: Record<string, { text: string; updatedAt: string }> = {};
    const draftDeletions: Record<string, string> = {};
    for (const row of draftRows.rows) {
      if (row.deleted_at) {
        draftDeletions[row.draft_key] = row.deleted_at.toISOString();
        continue;
      }
      drafts[row.draft_key] = { text: row.text, updatedAt: row.updated_at.toISOString() };
    }
    return {
      readCursors,
      mutes: muteRows.rows.map((row) => row.channel_id),
      prefs: normalizePrefs(prefs.rows[0]?.prefs),
      drafts,
      draftDeletions,
      channels: await listChannelsFor(client, userId),
    };
  }

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

  app.get('/api/sync', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { after?: string; limit?: string };
    const after = q.after == null ? 0 : Number(q.after);
    const rawLimit = q.limit == null ? 500 : Number(q.limit);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(rawLimit) || rawLimit <= 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'after must be non-negative and limit positive' });
    }
    const limit = Math.min(rawLimit, 1000);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      // Events and state are read from one snapshot so nextCursor covers
      // exactly the event set represented in this sync response.
      const page = await listVisibleSyncEvents(client, { userId: user.id, after, limit });
      const state = await syncStateSnapshot(client, user.id);
      await client.query('COMMIT');
      return { ...page, state };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

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

  // === /atrium internal node-facing routes (#72 P5a) ===
  async function resolveViewer(viewerId: string, reply: FastifyReply): Promise<UserRef | null> {
    const res = await pool.query<{
      id: string;
      handle: string;
      display_name: string;
    }>(
      `SELECT u.id, u.handle, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.spawned_by
       WHERE s.id::text = $1 OR s.centaur_thread_key = $1
       LIMIT 1`,
      [viewerId],
    );
    const user = res.rows[0];
    if (!user) {
      reply.code(404).send({ error: 'viewer_not_found', message: 'viewer session not found' });
      return null;
    }
    return { id: user.id, handle: user.handle, displayName: user.display_name };
  }

  app.get('/api/internal/sessions/:viewerId/atrium/changes', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { viewerId } = req.params as { viewerId: string };
    const q = req.query as { since?: string; limit?: string };
    const changefeed = await import('./session-record-changefeed.js');

    let cursor = changefeed.SESSION_RECORD_CHANGE_CURSOR_ZERO;
    if (typeof q.since === 'string' && q.since.length > 0) {
      const m = /^(\d+)\.(\d+)$/.exec(q.since);
      if (!m) {
        return reply.code(400).send({ error: 'bad_query', message: 'since must be "<xid>.<id>"' });
      }
      cursor = { xid: m[1]!, id: m[2]! };
    }

    let limit = 500;
    if (typeof q.limit === 'string') {
      const n = Number(q.limit);
      if (!Number.isInteger(n) || n < 1 || n > 5000) {
        return reply.code(400).send({ error: 'bad_query', message: 'limit must be 1..5000' });
      }
      limit = n;
    }

    const viewerUser = await resolveViewer(viewerId, reply);
    if (!viewerUser) return;

    const page = await changefeed.sessionRecordChangesSince(pool, {
      userId: viewerUser.id,
      cursor,
      limit,
    });
    return reply.send({
      rows: page.rows,
      next_cursor: `${page.nextCursor.xid}.${page.nextCursor.id}`,
    });
  });

  app.get('/api/internal/sessions/:viewerId/atrium/sessions/:targetId/:doc', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { viewerId, targetId, doc } = req.params as {
      viewerId: string;
      targetId: string;
      doc: string;
    };
    const viewerUser = await resolveViewer(viewerId, reply);
    if (!viewerUser) return;

    if (!(await sessionRuns.userCanAccessSession(targetId, viewerUser.id))) {
      return reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
    }

    const projection = await import('./atrium-session-projection.js');
    switch (doc) {
      case 'transcript': {
        const records = await projection.loadSessionRecords(pool, targetId, 'lean');
        return reply.type('text/markdown; charset=utf-8').send(projection.renderTranscriptMarkdown(records));
      }
      case 'full': {
        if (!(await canViewFull(viewerUser.id))) return fullViewForbidden(reply);
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        return reply.type('text/markdown; charset=utf-8').send(projection.renderFullMarkdown(records));
      }
      case 'summary': {
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        const meta = await projection.buildSessionMeta(pool, targetId);
        return reply.type('text/markdown; charset=utf-8').send(projection.renderSummaryMarkdown(records, meta));
      }
      case 'meta':
        return reply.type('application/json').send(await projection.buildSessionMeta(pool, targetId));
      case 'tools': {
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        return reply.type('text/markdown; charset=utf-8').send(projection.renderToolsMarkdown(records));
      }
      case 'artifacts': {
        const records = await projection.loadSessionRecords(pool, targetId, 'lean');
        return reply.type('text/markdown; charset=utf-8').send(projection.renderArtifactsMarkdown(records));
      }
      case 'changes-doc': {
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        return reply.type('text/markdown; charset=utf-8').send(projection.renderChangesMarkdown(records));
      }
      case 'events': {
        if (!(await canViewFull(viewerUser.id))) return fullViewForbidden(reply);
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        return reply.type('application/jsonl; charset=utf-8').send(projection.renderEventsJsonl(records));
      }
      default:
        return reply.code(404).send({ error: 'doc_not_found', message: 'atrium doc not found' });
    }
  });

  // Harness-resume (rollout-JSONL): capture the harness CLI transcript snapshot
  // (the daemon PUTs it each turn) + serve it back for cold-start restore. Stored
  // outside the artifact ledger — internal harness state, not a user work product.
  app.get('/api/internal/sessions/:id/harness-transcript', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const t = await loadHarnessTranscript(pool, { getObjectBytes }, session.id, harness);
    if (!t) return reply.code(404).send({ error: 'not_found', message: 'no transcript captured' });
    reply.header('Content-Type', 'application/x-ndjson');
    reply.header('X-Transcript-Sha256', t.sha256);
    return reply.send(t.bytes);
  });

  await app.register(async (ht) => {
    ht.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.maxUploadBytes }, (_req, body, done) =>
      done(null, body),
    );
    ht.put('/api/internal/sessions/:id/harness-transcript', async (req, reply) => {
      if (!requireCaptureKey(req, reply)) return;
      const { id } = req.params as { id: string };
      const harness = (req.query as { harness?: string }).harness ?? '';
      if (!isHarness(harness)) {
        return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
      }
      const session = await resolveInternalSessionRef(id);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length === 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'empty transcript body' });
      }
      const { size, sha256 } = await storeHarnessTranscript(pool, { uploadObject }, session.id, harness, bytes);
      return reply.send({ size_bytes: size, sha256 });
    });
  });

  app.get('/api/internal/sessions/:id/harness-state-bundle', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const ref = await resolveInternalSessionRef(id);
    if (!ref) return reply.code(404).send({ error: 'session_not_found' });
    const bundle = await loadHarnessStateBundle(pool, ref.id, harness);
    if (!bundle) return reply.code(404).send({ error: 'not_found', message: 'no harness-state bundle captured' });
    return reply.send(bundle);
  });

  app.put('/api/internal/sessions/:id/harness-state-bundle', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const ref = await resolveInternalSessionRef(id);
    if (!ref) return reply.code(404).send({ error: 'session_not_found' });
    try {
      const { size, sha256 } = await storeHarnessStateBundle(
        pool,
        { uploadObject },
        ref.id,
        harness,
        (req.body ?? {}) as { adapterVersion?: string; manifest?: unknown },
      );
      return reply.send({ size_bytes: size, sha256 });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid harness-state bundle';
      return reply.code(400).send({ error: 'bad_request', message });
    }
  });

  app.put('/api/internal/sessions/:id/profile-candidates', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const provider = harness === 'codex' ? CODEX_PROVIDER : CLAUDE_CODE_PROVIDER;
    const proposal = await agentProfiles.ingestSessionProposal(session.id, provider, req.body ?? {});
    return reply.send({ proposal });
  });

  app.put('/api/internal/sessions/:id/profile-baseline', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const provider = harness === 'codex' ? CODEX_PROVIDER : CLAUDE_CODE_PROVIDER;
    const { baselineHash } = await agentProfiles.putSessionBaseline(session.id, provider, req.body ?? {});
    return reply.send({ baselineHash });
  });

  // === A2 bundle-CAS additions ===
  app.get('/api/internal/sessions/:id/profile-bundles', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const provider = harness === 'codex' ? CODEX_PROVIDER : CLAUDE_CODE_PROVIDER;
    const bundles = await listSessionProfileBundles(pool, session.id, provider);
    return reply.send({ bundles });
  });

  app.get('/api/internal/sessions/:id/profile-bundle-blob', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const sha256 = normalizeBundleSha((req.query as { sha256?: string }).sha256);
    const bytes = await loadProfileBundleBlob(pool, { getObjectBytes }, sha256);
    if (!bytes) return reply.code(404).send({ error: 'not_found', message: 'profile bundle blob not found' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('X-Profile-Bundle-Sha256', sha256);
    return reply.send(bytes);
  });

  await app.register(async (profileBundleBlob) => {
    profileBundleBlob.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_PROFILE_BUNDLE_BLOB_BYTES },
      (_req, body, done) => done(null, body),
    );
    profileBundleBlob.put('/api/internal/sessions/:id/profile-bundle-blob', async (req, reply) => {
      if (!requireCaptureKey(req, reply)) return;
      const { id } = req.params as { id: string };
      const session = await resolveInternalSessionRef(id);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const q = req.query as { sha256?: string; path?: string };
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await storeProfileBundleBlob(
        pool,
        { uploadObject, headObject },
        { sha256: q.sha256 ?? '', path: q.path ?? '', bytes },
      );
      return reply.send(result);
    });
  });

  await registerInternalWarmcacheRoutes(app, {
    pool,
    requireCaptureKey,
    resolveInternalSessionRef,
  });

  app.put('/api/internal/sessions/:id/provider-credential-refresh', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const ref = await resolveInternalSessionRef(id);
    if (!ref) return reply.code(404).send({ error: 'session_not_found' });
    const session = await pool.query<{ spawned_by: string }>('SELECT spawned_by FROM sessions WHERE id = $1', [ref.id]);
    const ownerId = session.rows[0]?.spawned_by;
    if (!ownerId) return reply.code(404).send({ error: 'session_not_found' });

    const body = (req.body ?? {}) as { token?: unknown; authJson?: unknown };
    try {
      if (harness === 'codex') {
        const authJson =
          typeof body.authJson === 'string'
            ? body.authJson
            : body.authJson && typeof body.authJson === 'object'
              ? JSON.stringify(body.authJson)
              : '';
        if (!authJson.trim()) {
          return reply.code(400).send({ error: 'bad_request', message: 'Codex authJson required' });
        }
        const provider = await providerCredentials.upsertCodexAuthJson(ownerId, authJson);
        return reply.send({ provider });
      }
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!token) {
        return reply.code(400).send({ error: 'bad_request', message: 'Claude token required' });
      }
      const provider = await providerCredentials.upsertClaudeToken(ownerId, token);
      return reply.send({ provider });
    } catch (err) {
      const provider = harness === 'codex' ? CODEX_PROVIDER : CLAUDE_CODE_PROVIDER;
      const message = err instanceof Error ? err.message : 'invalid refreshed credential';
      await providerCredentials.markProviderAuthRequired(provider, ownerId, message);
      return reply.code(400).send({ error: 'bad_request', message });
    }
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
