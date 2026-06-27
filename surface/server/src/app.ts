import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { normalizePrefs } from '@atrium/surface-client/prefs';
import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { verifySession } from './cookie.js';
import {
  DomainError,
  canAccessChannel,
  listChannelsFor,
  listVisibleSyncEvents,
  type UserRef,
  type WireEvent,
} from './events.js';
import { workspaceIdsFor, workspaceMemberExists } from './membership.js';
import { WsHub } from './hub.js';
import { clearReceiptTimers } from './push.js';
import {
  copyObject,
  deleteObject,
  ensureBucket,
  getObjectBytes,
  headObject,
  presignGet,
  presignPut,
  uploadObject,
  uploadObjectStream,
} from './s3.js';
import {
  isHarness,
  loadHarnessStateBundle,
  loadHarnessTranscript,
  storeHarnessStateBundle,
  storeHarnessTranscript,
} from './harness-transcript.js';
import { SessionRuns, type SessionRunsOptions } from './session-runs.js';
import { writeBackArtifact, writeBackDelete } from './artifact-writeback.js';
import {
  ArtifactLedger,
  casBlobKey,
  type ChangeCursor,
  CHANGE_CURSOR_ZERO,
  type CommitVersionGroupFile,
} from './artifact-ledger.js';
import { artifactPathInRoots, readableArtifactRootsForSession, type ArtifactScopeRoot } from './artifact-scope.js';
import { canonicalizeSessionArtifactPath, InvalidArtifactPathError } from './artifact-path.js';
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
import {
  bumpWarmcacheLastHydrated,
  loadWarmcacheBlob,
  loadWarmcacheManifest,
  MAX_WARMCACHE_BLOB_BYTES,
  MAX_WARMCACHE_MANIFEST_ENTRIES,
  normalizeWarmcacheSha,
  registerWarmcacheManifest,
  storeWarmcacheBlob,
  type WarmcacheEntry,
} from './warmcache-store.js';
import { DemoCentaurClient } from './demo-centaur.js';
import { classifyMedia } from './media-classifier.js';
import { AppRegistry } from './app-registry.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerAtriumRoutes } from './routes/atrium.js';
import { registerCallRoutes } from './routes/calls.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerEntryRoutes } from './routes/entries.js';
import { registerFileRoutes } from './routes/files.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMeRoutes } from './routes/me.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerPushRoutes } from './routes/push.js';
import { registerSessionRoutes } from './routes/sessions.js';
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

function isReadableStream(value: unknown): value is Readable {
  const candidate = value as { pipe?: unknown } | null;
  return candidate != null && typeof candidate.pipe === 'function';
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

  function isAnswerBody(value: unknown): value is Record<string, { answers: string[] }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    for (const entry of Object.values(value as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const answers = (entry as { answers?: unknown }).answers;
      if (!Array.isArray(answers) || !answers.every((answer) => typeof answer === 'string')) {
        return false;
      }
    }
    return true;
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

  function isQuestionNotPendingError(err: unknown): boolean {
    return err instanceof DomainError && err.code === 'question_not_pending';
  }

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

  // Poll the gap-free change-feed (the daemon's inbound trigger).
  app.get('/api/internal/sessions/:id/artifacts/changes', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const q = req.query as { since?: string; limit?: string };
    let cursor: ChangeCursor = CHANGE_CURSOR_ZERO;
    if (typeof q.since === 'string' && q.since.length > 0) {
      const m = /^(\d+)\.(\d+)$/.exec(q.since);
      if (!m) return reply.code(400).send({ error: 'bad_query', message: 'since must be "<xid>.<id>"' });
      cursor = { xid: m[1]!, id: m[2]! };
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const page = await new ArtifactLedger(pool).changesSince(session.id, cursor, 500);
    return reply.send({
      activePrefix: `shared/channels/${session.channelId}`,
      rows: page.rows,
      next_cursor: `${page.nextCursor.xid}.${page.nextCursor.id}`,
    });
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

  // Fetch a specific version's bytes (the daemon's inbound adopt fetch). Ledger
  // blobs must already be durable in CAS/S3, so we serve straight from the store.
  app.get('/api/internal/sessions/:id/artifacts/raw', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string; seq?: string };
    if (typeof q.path !== 'string' || q.path.length === 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const access = await sessionArtifactAccess(session.id);
    const path = canonicalizeRouteArtifactPath(reply, q.path, {
      sessionId: session.id,
      channelId: session.channelId,
      readableChannelIds: access.readableChannelIds,
    });
    if (!path) return;
    if (!artifactPathInRoots(path, access.readableRoots)) {
      return reply.code(404).send({ error: 'not_found', message: 'no servable version' });
    }
    const ref = typeof q.seq === 'string' && /^\d+$/.test(q.seq) ? { seq: Number(q.seq) } : { pointer: 'latest' };
    const v = await new ArtifactLedger(pool).resolveVersion(session.id, path, ref, {
      readableChannelIds: access.readableChannelIds,
    });
    if (!v || v.kind === 'deleted') {
      return reply.code(404).send({ error: 'not_found', message: 'no servable version' });
    }
    if (!v.blobSha || !v.s3Key) {
      return reply.code(503).send({ error: 'blob_unavailable', message: 'artifact bytes are not durable in CAS' });
    }
    const bytes = await getObjectBytes(v.s3Key);
    reply.header('Content-Type', v.mime || 'application/octet-stream');
    reply.header('X-Artifact-Seq', String(v.seq));
    return reply.send(bytes);
  });

  // Internal: the node's hydration manifest (the subscription set) — this
  // session's workspace view (own `scratch/<session>/` + all `shared/`), each
  // path with its latest seq. The node fetches this at provision time, pulls each
  // path via `/artifacts/raw`, and materializes the overlay lower (5B-3
  // hydrate_lower). Unlike the user-facing route it does NOT drop private scope:
  // the node must hydrate the session's own scratch into its lower.
  app.get('/api/internal/sessions/:id/hydration-scope', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const access = await sessionArtifactAccess(session.id);
    const paths = await new ArtifactLedger(pool).sessionScope(session.id);
    return reply.send({
      sessionId: session.id,
      scope: 'session',
      activePrefix: access.activePrefix,
      readableRoots: serializeArtifactRoots(access.readableRoots),
      writableRoots: serializeArtifactRoots(access.writableRoots),
      paths,
    });
  });

  // Capture a change (the daemon's node-scan output). x-api-key + raw body.
  await app.register(async (capture) => {
    capture.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.maxUploadBytes }, (_req, body, done) =>
      done(null, body),
    );
    capture.post('/api/internal/sessions/:id/artifacts/capture', async (req, reply) => {
      if (!requireCaptureKey(req, reply)) return;
      const { id } = req.params as { id: string };
      const path = (req.query as { path?: string }).path;
      if (typeof path !== 'string' || path.length === 0) {
        return reply.code(400).send({ error: 'bad_query', message: 'valid path required' });
      }
      const session = await resolveInternalSessionRef(id);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const access = await sessionArtifactAccess(session.id);
      const canonicalPath = canonicalizeRouteArtifactPath(reply, path, {
        sessionId: session.id,
        channelId: session.channelId,
        readableChannelIds: access.readableChannelIds,
      });
      if (!canonicalPath) return;
      if (!artifactPathInRoots(canonicalPath, access.writableRoots)) {
        return reply.code(403).send({ error: 'artifact_read_only', message: 'artifact path is not writable' });
      }

      const baseSeq = parseBaseSeq(firstHeader(req.headers['x-artifact-base-seq']));
      if (baseSeq === false) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
      }
      const isDelete = firstHeader(req.headers['x-artifact-delete']) === 'true';
      const author = `node:${id}`;
      const result = isDelete
        ? await writeBackDelete({
            pool,
            channelId: session.channelId,
            sessionId: session.id,
            path: canonicalPath,
            author,
            ...(baseSeq == null ? {} : { baseSeq }),
          })
        : await writeBackArtifact({
            pool,
            storage: { uploadObject, getObjectBytes, headObject },
            channelId: session.channelId,
            sessionId: session.id,
            path: canonicalPath,
            bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
            mime: normalizeMime(firstHeader(req.headers['content-type'])),
            author,
            ...(baseSeq == null ? {} : { baseSeq }),
          });
      if (!result.ok) {
        return reply.code(409).send({
          error: result.reason,
          ...(result.baseSeq != null ? { baseSeq: result.baseSeq } : {}),
          ...(result.latestSeq != null ? { latestSeq: result.latestSeq } : {}),
        });
      }
      return reply.send({ seq: result.seq, status: result.status });
    });
  });

  // === H8 streaming capture ===
  await app.register(async (captureStream) => {
    captureStream.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    captureStream.post('/api/internal/sessions/:id/artifacts/capture-stream', async (req, reply) => {
      if (!requireCaptureKey(req, reply)) return;
      const { id } = req.params as { id: string };
      const path = (req.query as { path?: string }).path;
      if (typeof path !== 'string' || path.length === 0) {
        return reply.code(400).send({ error: 'bad_query', message: 'valid path required' });
      }
      const session = await resolveInternalSessionRef(id);
      if (!session) return reply.code(404).send({ error: 'session_not_found' });
      const access = await sessionArtifactAccess(session.id);
      const canonicalPath = canonicalizeRouteArtifactPath(reply, path, {
        sessionId: session.id,
        channelId: session.channelId,
        readableChannelIds: access.readableChannelIds,
      });
      if (!canonicalPath) return;
      if (!artifactPathInRoots(canonicalPath, access.writableRoots)) {
        return reply.code(403).send({ error: 'artifact_read_only', message: 'artifact path is not writable' });
      }

      const baseSeq = parseBaseSeq(firstHeader(req.headers['x-artifact-base-seq']));
      if (baseSeq === false) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
      }

      const mime = normalizeMime(firstHeader(req.headers['content-type']));
      const source = isReadableStream(req.body) ? req.body : Readable.from(Buffer.alloc(0));
      const stagingKey = `cas-staging/${randomBytes(16).toString('hex')}`;
      let stagingDeleted = false;
      try {
        const hash = createHash('sha256');
        let sizeBytes = 0;
        const sampleChunks: Buffer[] = [];
        let sampleBytes = 0;
        const hashingStream = new Transform({
          transform(chunk, encoding, callback) {
            const bytes = Buffer.isBuffer(chunk)
              ? chunk
              : typeof chunk === 'string'
                ? Buffer.from(chunk, encoding)
                : Buffer.from(chunk as Uint8Array);
            hash.update(bytes);
            sizeBytes += bytes.byteLength;
            if (sampleBytes < 8192) {
              const next = bytes.subarray(0, Math.min(bytes.byteLength, 8192 - sampleBytes));
              sampleChunks.push(next);
              sampleBytes += next.byteLength;
            }
            callback(null, chunk);
          },
        });
        const upload = uploadObjectStream(stagingKey, hashingStream, mime);
        await Promise.all([pipeline(source, hashingStream), upload]);

        const sha = hash.digest('hex');
        const finalKey = casBlobKey(sha);
        const classification = classifyMedia(Buffer.concat(sampleChunks), {
          declaredMime: mime,
          filename: canonicalPath,
        });
        await copyObject(stagingKey, finalKey);
        await deleteObject(stagingKey);
        stagingDeleted = true;

        const ledger = new ArtifactLedger(pool);
        await withTx(pool, async (client) => {
          await ledger.upsertBlob(client, {
            sha256: sha,
            sizeBytes,
            mime,
            s3Key: finalKey,
            classification,
          });
        });
        // First version of a path is 'created', else 'modified' (mirrors the
        // buffered write-back path; kind is cosmetic but should be accurate).
        const prior = await pool.query(
          `SELECT 1
             FROM sessions s
             JOIN artifacts a ON a.workspace_id = s.workspace_id
            WHERE s.id = $1 AND a.path = $2
            LIMIT 1`,
          [session.id, canonicalPath],
        );
        const result = await ledger.commitVersion({
          sessionId: session.id,
          channelId: session.channelId,
          path: canonicalPath,
          blobSha: sha,
          sizeBytes,
          mime,
          kind: prior.rows[0] ? 'modified' : 'created',
          mergeClass: 'immutable-data',
          author: `node:${id}`,
          ...(baseSeq == null ? {} : { baseSeq }),
        });
        if (!result.ok) {
          // Large streamed files are immutable-class; stale OCC is rebased by the node daemon.
          return reply.code(409).send({ error: 'stale_base', latestSeq: result.latestSeq, baseSeq: result.baseSeq });
        }
        return reply.send({ seq: result.seq, status: 'normal' });
      } finally {
        if (!stagingDeleted) {
          await deleteObject(stagingKey).catch(() => {});
        }
      }
    });
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

  // === Warm-cache (dep/build cache) hydration ===
  // Machine state, workspace-scoped, deliberately NOT in the artifact ledger. The
  // Centaur node daemon uploads cache blobs to the shared CAS and registers a
  // per-(workspace, lockfile-hash, kind) manifest; the overlay lower is hydrated
  // from that manifest on a cache hit. All routes use capture-key (machine) auth.
  const warmcacheWorkspaceExists = async (id: string): Promise<boolean> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
    const r = await pool.query('SELECT 1 FROM workspaces WHERE id = $1', [id]);
    return r.rows.length > 0;
  };

  app.get('/api/internal/cache/blob', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const sha256 = normalizeWarmcacheSha((req.query as { sha256?: string }).sha256);
    const bytes = await loadWarmcacheBlob(pool, { getObjectBytes }, sha256);
    if (!bytes) return reply.code(404).send({ error: 'not_found', message: 'warm-cache blob not found' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('X-Warmcache-Sha256', sha256);
    return reply.send(bytes);
  });

  await app.register(async (warmcacheBlob) => {
    warmcacheBlob.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_WARMCACHE_BLOB_BYTES },
      (_req, body, done) => done(null, body),
    );
    warmcacheBlob.put('/api/internal/cache/blob', async (req, reply) => {
      if (!requireCaptureKey(req, reply)) return;
      const sha256 = (req.query as { sha256?: string }).sha256 ?? '';
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await storeWarmcacheBlob(pool, { uploadObject, headObject }, { sha256, bytes });
      return reply.send(result);
    });
  });

  app.put('/api/internal/cache/manifest', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const body = (req.body ?? {}) as {
      workspace_id?: unknown;
      lockfile_hash?: unknown;
      kind?: unknown;
      entries?: unknown;
    };
    const workspaceId = typeof body.workspace_id === 'string' ? body.workspace_id : '';
    if (!(await warmcacheWorkspaceExists(workspaceId))) {
      return reply.code(404).send({ error: 'workspace_not_found' });
    }
    const entries = Array.isArray(body.entries) ? (body.entries as WarmcacheEntry[]) : [];
    if (entries.length > MAX_WARMCACHE_MANIFEST_ENTRIES) {
      return reply.code(413).send({ error: 'manifest_too_large', message: 'too many cache entries' });
    }
    const result = await registerWarmcacheManifest(pool, {
      workspaceId,
      lockfileHash: String(body.lockfile_hash ?? ''),
      kind: String(body.kind ?? ''),
      entries,
    });
    return reply.send(result);
  });

  app.get('/api/internal/cache/hydration', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const q = req.query as { workspace_id?: string; lockfile_hash?: string; kind?: string };
    const workspaceId = typeof q.workspace_id === 'string' ? q.workspace_id : '';
    if (!(await warmcacheWorkspaceExists(workspaceId))) {
      return reply.code(404).send({ error: 'workspace_not_found' });
    }
    const entries = await loadWarmcacheManifest(pool, {
      workspaceId,
      lockfileHash: String(q.lockfile_hash ?? ''),
      kind: String(q.kind ?? ''),
    });
    try {
      await bumpWarmcacheLastHydrated(pool, {
        workspaceId,
        lockfileHash: String(q.lockfile_hash ?? ''),
        kind: String(q.kind ?? ''),
      });
    } catch (err) {
      req.log.warn({ err, workspaceId }, 'warm-cache last hydration bump failed');
    }
    return reply.send({
      workspaceId,
      scope: 'warmcache',
      kind: String(q.kind ?? ''),
      lockfileHash: String(q.lockfile_hash ?? ''),
      entries,
    });
  });

  // Session-scoped warm-cache variants: the node daemon holds a session id, not a
  // workspace id, so resolve the workspace from the session (consistent with every
  // other internal daemon route). Blob bytes still flow through the workspace-agnostic
  // content-addressed /api/internal/cache/blob routes above.
  app.get('/api/internal/sessions/:id/cache/hydration', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const q = req.query as { lockfile_hash?: string; kind?: string };
    const entries = await loadWarmcacheManifest(pool, {
      workspaceId: session.workspaceId,
      lockfileHash: String(q.lockfile_hash ?? ''),
      kind: String(q.kind ?? ''),
    });
    try {
      await bumpWarmcacheLastHydrated(pool, {
        workspaceId: session.workspaceId,
        lockfileHash: String(q.lockfile_hash ?? ''),
        kind: String(q.kind ?? ''),
      });
    } catch (err) {
      req.log.warn({ err, workspaceId: session.workspaceId }, 'warm-cache last hydration bump failed');
    }
    return reply.send({
      workspaceId: session.workspaceId,
      scope: 'warmcache',
      kind: String(q.kind ?? ''),
      lockfileHash: String(q.lockfile_hash ?? ''),
      entries,
    });
  });

  app.put('/api/internal/sessions/:id/cache/manifest', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const body = (req.body ?? {}) as { lockfile_hash?: unknown; kind?: unknown; entries?: unknown };
    const entries = Array.isArray(body.entries) ? (body.entries as WarmcacheEntry[]) : [];
    if (entries.length > MAX_WARMCACHE_MANIFEST_ENTRIES) {
      return reply.code(413).send({ error: 'manifest_too_large', message: 'too many cache entries' });
    }
    const result = await registerWarmcacheManifest(pool, {
      workspaceId: session.workspaceId,
      lockfileHash: String(body.lockfile_hash ?? ''),
      kind: String(body.kind ?? ''),
      entries,
    });
    return reply.send(result);
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

  // === H10 commit-group additions ===
  app.post('/api/internal/sessions/:id/artifacts/commit-group', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      group_id?: unknown;
      files?: unknown;
    };
    const badManifest = (message: string) => reply.code(400).send({ error: 'bad_manifest', message });
    if (typeof body.group_id !== 'string' || body.group_id.length === 0) {
      return badManifest('group_id is required');
    }
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return badManifest('files must be a non-empty array');
    }
    const session = await resolveInternalSessionRef(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const access = await sessionArtifactAccess(session.id);

    const files: CommitVersionGroupFile[] = [];
    const seenPaths = new Set<string>();
    for (const raw of body.files) {
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        return badManifest('each file must be an object');
      }
      const file = raw as {
        path?: unknown;
        blob_sha?: unknown;
        size_bytes?: unknown;
        mime?: unknown;
        base_seq?: unknown;
        kind?: unknown;
        merge_class?: unknown;
      };
      if (typeof file.path !== 'string' || file.path.length === 0) {
        return badManifest('valid path required');
      }
      let path: string;
      try {
        path = canonicalizeSessionArtifactPath(file.path, {
          sessionId: session.id,
          channelId: session.channelId,
          readableChannelIds: access.readableChannelIds,
        });
      } catch (err) {
        if (err instanceof InvalidArtifactPathError) return badManifest(err.message);
        throw err;
      }
      if (!artifactPathInRoots(path, access.writableRoots)) {
        return badManifest('artifact path is not writable');
      }
      if (seenPaths.has(path)) return badManifest('duplicate path');
      seenPaths.add(path);
      if (file.kind !== 'created' && file.kind !== 'modified' && file.kind !== 'deleted') {
        return badManifest('kind must be created, modified, or deleted');
      }
      const blobSha = file.blob_sha;
      if (file.kind === 'deleted') {
        if (blobSha !== null) return badManifest('deleted files must use blob_sha null');
      } else if (typeof blobSha !== 'string' || blobSha.length === 0) {
        return badManifest('created and modified files require blob_sha');
      }
      if (!Number.isSafeInteger(file.size_bytes) || (file.size_bytes as number) < 0) {
        return badManifest('size_bytes must be a non-negative integer');
      }
      if (typeof file.mime !== 'string' || file.mime.length === 0) {
        return badManifest('mime is required');
      }
      let baseSeq: number | null | undefined;
      if (file.base_seq === null || file.base_seq === undefined) {
        baseSeq = file.base_seq;
      } else if (Number.isSafeInteger(file.base_seq) && (file.base_seq as number) > 0) {
        baseSeq = file.base_seq as number;
      } else {
        return badManifest('base_seq must be a positive integer or null');
      }
      let mergeClass: CommitVersionGroupFile['mergeClass'];
      if (file.merge_class !== undefined) {
        if (
          file.merge_class !== 'immutable-data' &&
          file.merge_class !== 'mergeable-doc' &&
          file.merge_class !== 'derived-output'
        ) {
          return badManifest('merge_class is invalid');
        }
        mergeClass = file.merge_class;
      }
      files.push({
        path,
        blobSha: file.kind === 'deleted' ? null : (blobSha as string),
        sizeBytes: file.size_bytes as number,
        mime: normalizeMime(file.mime),
        baseSeq,
        kind: file.kind,
        ...(mergeClass === undefined ? {} : { mergeClass }),
      });
    }

    const result = await new ArtifactLedger(pool).commitVersionGroup({
      sessionId: session.id,
      channelId: session.channelId,
      groupId: body.group_id,
      author: `node:${id}`,
      files,
    });
    if (!result.ok) return reply.code(409).send(result);
    return reply.send(result);
  });

  app.get('/api/sessions/:id/stream', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { after_event_id?: string };
    const afterEventId = q.after_event_id == null ? 0 : Number(q.after_event_id);
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'after_event_id must be a nonnegative integer' });
    }
    const session = await sessionRuns.getSessionForUser(id, user.id);
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    await sessionRuns.streamCentaurEvents(session, user.id, afterEventId, reply.raw, abort.signal);
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

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string; opId?: unknown };
    const opId = optionalOpId(body);
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    try {
      await runMutation({
        userId: user.id,
        opId,
        opType: 'session.steer',
        body: { sessionId: id, text },
        fn: async (client) => {
          await sessionRuns.postUserMessageInTx(client, id, user.id, text);
          return { ok: true as const };
        },
        onApplied: () => {
          sessionRuns.afterPostUserMessage(id);
        },
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'provider_auth_required') {
        await sessionRuns.markClaudeAuthMissing(id).catch(() => {});
      }
      throw err;
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/answer', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { questionId?: unknown; answers?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.questionId !== 'string' || !isAnswerBody(body.answers)) {
      return reply.code(400).send({ error: 'bad_request', message: 'questionId and answers are required' });
    }
    if (opId) {
      let event: WireEvent | null = null;
      try {
        await runMutation({
          userId: user.id,
          opId,
          opType: 'session.answer',
          body: { sessionId: id, questionId: body.questionId, answers: body.answers },
          fn: async (client) => {
            event = await sessionRuns.answerQuestionInTx(
              client,
              id,
              user,
              body.questionId as string,
              body.answers as Record<string, { answers: string[] }>,
            );
            return { ok: true as const };
          },
          onApplied: () => {
            if (event) hub.publishEvent(event);
          },
        });
      } catch (err) {
        if (isQuestionNotPendingError(err)) {
          await sessionRuns.clearStalePendingQuestion(id, body.questionId);
        }
        throw err;
      }
    } else {
      await sessionRuns.answerQuestion(id, user, body.questionId, body.answers);
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/seat/request', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await sessionRuns.requestSeat(id, user.id);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/seat/grant', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { userId?: string };
    if (!body.userId || typeof body.userId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'userId required' });
    }
    await sessionRuns.grantSeat(id, user.id, body.userId);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/seat/take', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await sessionRuns.takeSeat(id, user.id);
    return reply.code(202).send({ ok: true });
  });

  // A watcher proposes a steer; any member with session access may suggest.
  app.post('/api/sessions/:id/suggestions', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string; opId?: unknown };
    const opId = optionalOpId(body);
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'suggestion text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'suggestion exceeds 8KB' });
    }
    let event: WireEvent | null = null;
    await runMutation({
      userId: user.id,
      opId,
      opType: 'session.suggestion.create',
      body: { sessionId: id, text },
      fn: async (client) => {
        event = await sessionRuns.createSuggestionInTx(client, id, user.id, text);
        return { ok: true as const };
      },
      onApplied: () => {
        if (event) hub.publishEvent(event);
      },
    });
    return reply.code(202).send({ ok: true });
  });

  // Driver-only (enforced in the DAO): send / edit-then-send / dismiss.
  app.post('/api/sessions/:id/suggestions/:suggestionId/resolve', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id, suggestionId } = req.params as { id: string; suggestionId: string };
    // Guard the id shape so a non-UUID path param 404s instead of surfacing a
    // Postgres cast error as a 500 (mirrors getSessionRow).
    if (!/^[0-9a-f-]{36}$/i.test(suggestionId)) {
      return reply.code(404).send({ error: 'suggestion_not_found', message: 'suggestion not found' });
    }
    const body = (req.body ?? {}) as { action?: unknown; text?: unknown; note?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (body.action !== 'send' && body.action !== 'dismiss') {
      return reply.code(400).send({ error: 'bad_request', message: "action must be 'send' or 'dismiss'" });
    }
    const action = body.action;
    // text only applies to send; note only to dismiss.
    const text = action === 'send' && typeof body.text === 'string' ? body.text : undefined;
    const note = action === 'dismiss' && typeof body.note === 'string' ? body.note : undefined;
    if (text !== undefined && Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    let result: { event: WireEvent; postedSteer: boolean } | null = null;
    await runMutation({
      userId: user.id,
      opId,
      opType: 'session.suggestion.resolve',
      body: {
        sessionId: id,
        suggestionId,
        action,
        ...(text !== undefined ? { text } : {}),
        ...(note !== undefined ? { note } : {}),
      },
      fn: async (client) => {
        result = await sessionRuns.resolveSuggestionInTx(client, id, user.id, suggestionId, action, { text, note });
        return { ok: true as const };
      },
      onApplied: () => {
        if (!result) return;
        if (result.postedSteer) sessionRuns.afterPostUserMessage(id);
        hub.publishEvent(result.event);
      },
    });
    return reply.code(202).send({ ok: true });
  });

  // A watcher proposes an answer to the pending question (any member; the DAO
  // refuses the driver, who answers directly).
  app.post('/api/sessions/:id/question-proposals', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { questionId?: unknown; answers?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.questionId !== 'string' || !isAnswerBody(body.answers)) {
      return reply.code(400).send({ error: 'bad_request', message: 'questionId and answers are required' });
    }
    const questionId = body.questionId;
    const answers = body.answers;
    let event: WireEvent | null = null;
    await runMutation({
      userId: user.id,
      opId,
      opType: 'session.answer.propose',
      body: { sessionId: id, questionId, answers },
      fn: async (client) => {
        event = await sessionRuns.createAnswerProposalInTx(client, id, user.id, questionId, answers);
        return { ok: true as const };
      },
      onApplied: () => {
        if (event) hub.publishEvent(event);
      },
    });
    return reply.code(202).send({ ok: true });
  });

  // Driver-only (enforced in the DAO): submit (answers the question) / dismiss.
  app.post('/api/sessions/:id/question-proposals/:proposalId/resolve', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    if (!/^[0-9a-f-]{36}$/i.test(proposalId)) {
      return reply.code(404).send({ error: 'proposal_not_found', message: 'proposal not found' });
    }
    const body = (req.body ?? {}) as { action?: unknown; note?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (body.action !== 'submit' && body.action !== 'dismiss') {
      return reply.code(400).send({ error: 'bad_request', message: "action must be 'submit' or 'dismiss'" });
    }
    const action = body.action;
    const note = action === 'dismiss' && typeof body.note === 'string' ? body.note : undefined;
    let result: { events: WireEvent[]; postedAnswer: boolean } | null = null;
    try {
      await runMutation({
        userId: user.id,
        opId,
        opType: 'session.answer.resolve',
        body: { sessionId: id, proposalId, action, ...(note !== undefined ? { note } : {}) },
        fn: async (client) => {
          result = await sessionRuns.resolveAnswerProposalInTx(client, id, user, proposalId, action, { note });
          return { ok: true as const };
        },
        onApplied: () => {
          if (!result) return;
          for (const event of result.events) hub.publishEvent(event);
        },
      });
    } catch (err) {
      if (action === 'submit' && isQuestionNotPendingError(err)) {
        await sessionRuns.clearStalePendingQuestionForProposal(id, proposalId);
      }
      throw err;
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/sessions/:id/cancel', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { opId?: unknown };
    const opId = optionalOpId(body);
    if (opId) {
      let events: WireEvent[] = [];
      await runMutation({
        userId: user.id,
        opId,
        opType: 'session.cancel',
        body: { sessionId: id },
        fn: async (client) => {
          events = await sessionRuns.cancelSessionInTx(client, id, user.id);
          return { ok: true as const };
        },
        onApplied: () => {
          sessionRuns.afterCancelSession(id, events);
        },
      });
    } else {
      await sessionRuns.cancelSession(id, user.id);
    }
    return reply.code(202).send({ ok: true });
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
