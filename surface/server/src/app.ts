import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { DEFAULT_PREFS, normalizePrefs, type UserPrefs } from '@atrium/surface-client/prefs';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { signSession, verifySession } from './cookie.js';
import {
  addChannelMemberTx,
  DomainError,
  canAccessChannel,
  canAccessFile,
  createChannel,
  createWorkspace,
  deleteMessageTx,
  editMessageTx,
  ensureDefaultWorkspace,
  foldAnnotations,
  getOrCreateGdm,
  getOrCreateDm,
  leaveChannelTx,
  listChannelMembers,
  appendVoiceTranscribedEventTx,
  listChannelMessages,
  listChannelsFor,
  listThreadMessages,
  listUsers,
  listVisibleSyncEvents,
  postCommentTx,
  postMessage,
  REACTION_EMOJI,
  searchMessages,
  setEntryReactionTx,
  setReactionTx,
  type Workspace,
  type ReactionAction,
  type WireEvent,
  type UserRef,
} from './events.js';
import {
  addWorkspaceMember,
  isWorkspaceMember,
  workspaceIdsFor,
  workspaceMemberExists,
  workspaceMemberIds,
} from './membership.js';
import { WsHub } from './hub.js';
import { FILE_URL_TTL_S, fileSignature, verifyFileSignature } from './filesign.js';
import { clearReceiptTimers, sendMessagePush } from './push.js';
import { emailDeliveryConfigured, sendLoginCode } from './email.js';
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
import { SessionRuns, type ArtifactServePlan, type SessionRunsOptions } from './session-runs.js';
import { searchSessionRecords } from './session-search.js';
import { resolveEntry, tryDecodeHandle } from './entries.js';
import { writeBackArtifact, writeBackDelete } from './artifact-writeback.js';
import {
  ArtifactLedger,
  casBlobKey,
  type ChangeCursor,
  CHANGE_CURSOR_ZERO,
  type CommitVersionGroupFile,
} from './artifact-ledger.js';
import {
  artifactPathInRoots,
  classifyScope,
  readableArtifactRootsForSession,
  userCanReadSessionArtifactPath,
  type ArtifactScope,
  type ArtifactScopeRoot,
} from './artifact-scope.js';
import { loadConflictDetail } from './artifact-conflict.js';
import {
  canonicalizeSessionArtifactPath,
  displaySessionArtifactPath,
  InvalidArtifactPathError,
  sessionArtifactPathAliases,
} from './artifact-path.js';
import type { AttachmentMeta } from './events.js';
import { isUuid, withIdempotency } from './idempotency.js';
import type { CallTokenService } from './livekit.js';
import { createLiveKitTokenService } from './livekit.js';
import { loadCallWire, type CallRow } from './calls.js';
import { getVoipSender, sendIncomingCallVoipPushes, type VoipPushSender } from './voip.js';
import { CentaurClient } from '@atrium/centaur-client';
import {
  CLAUDE_CODE_PROVIDER,
  CODEX_PROVIDER,
  ProviderCredentials,
} from './provider-credentials.js';
import { AgentProfiles, providerFromProfileValue } from './agent-profiles.js';
import {
  listSessionProfileBundles,
  loadProfileBundleBlob,
  MAX_PROFILE_BUNDLE_BLOB_BYTES,
  normalizeBundleSha,
  storeProfileBundleBlob,
} from './profile-bundles.js';
import { DemoCentaurClient } from './demo-centaur.js';
import { classifyMedia, classifyMediaFromMime, type MediaClassification } from './media-classifier.js';
import { AppRegistry, type AppScope } from './app-registry.js';

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

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/i;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

/** Strip quotes/control chars so a sandbox-controlled artifact path can't inject
 * into the Content-Disposition header. Conservative: keeps a safe ASCII subset. */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : 'artifact';
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function badArtifactPath(reply: FastifyReply, err: unknown) {
  if (err instanceof InvalidArtifactPathError) {
    return reply.code(400).send({ error: 'bad_query', message: err.message });
  }
  throw err;
}

function canonicalizeRouteArtifactPath(
  reply: FastifyReply,
  input: string,
  ctx: { sessionId: string; channelId: string; readableChannelIds?: readonly string[] },
): string | null {
  try {
    return canonicalizeSessionArtifactPath(input, ctx);
  } catch (err) {
    badArtifactPath(reply, err);
    return null;
  }
}

function normalizeMime(value: string | undefined): string {
  const mime = (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

async function previewBytes(plan: ArtifactServePlan): Promise<Buffer> {
  if (plan.kind === 'redirect') {
    if (plan.s3Key) {
      return getObjectBytes(plan.s3Key);
    }
    const response = await fetch(plan.url);
    if (!response.ok) {
      throw new DomainError(502, 'artifact_preview_fetch_failed', 'failed to fetch artifact preview bytes');
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new DomainError(500, 'artifact_preview_unsupported_plan', 'unsupported artifact preview serve plan');
}

function resolveArtifactPreviewRenderer(path: string, mime: string | null, hint?: string): 'html-app' | 'react-jsx' {
  const normalizedHint = (hint ?? '').trim().toLowerCase();
  if (normalizedHint === 'react-jsx') return 'react-jsx';
  if (normalizedHint === 'html-app') return 'html-app';
  if (/\.(jsx|tsx)$/i.test(path)) return 'react-jsx';
  if ((mime ?? '').toLowerCase() === 'text/html' || /\.html?$/i.test(path)) return 'html-app';
  return 'html-app';
}

function reactJsxPreviewDocument(source: string, filename: string): string {
  const sourceJson = JSON.stringify(source);
  const titleJson = JSON.stringify(filename);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(filename)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <pre id="artifact-error" style="display:none; white-space:pre-wrap; padding:16px; color:#991b1b;"></pre>
  <script>
    const source = ${sourceJson};
    const title = ${titleJson};
    function showError(error) {
      const el = document.getElementById('artifact-error');
      el.style.display = 'block';
      el.textContent = String(error && error.stack ? error.stack : error);
    }
    function toRunnableJsx(input) {
      return input
        .replace(/^\\s*import\\s+.*?from\\s+['"].*?['"];?\\s*$/gm, '')
        .replace(/^\\s*import\\s+['"].*?['"];?\\s*$/gm, '')
        .replace(/export\\s+default\\s+function\\s+([A-Za-z0-9_$]+)/, 'function $1')
        .replace(/export\\s+default\\s+/, 'const App = ');
    }
    try {
      const cleaned = toRunnableJsx(source);
      // Force the classic JSX runtime: @babel/standalone now defaults the react
      // preset to the automatic runtime, which injects \`import { jsx } from
      // "react/jsx-runtime"\` — an import statement that throws inside new Function.
      // Classic emits React.createElement, which the scaffold supplies React for.
      const transformed = Babel.transform(cleaned, { presets: [['react', { runtime: 'classic' }]] }).code;
      const factory = new Function('React', transformed + '\\n; return typeof App !== "undefined" ? App : (typeof exports !== "undefined" && exports.default) || null;');
      const App = factory(React);
      if (!App) throw new Error('No default React component found in ' + title);
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
    } catch (error) {
      showError(error);
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface MessageAttachmentFileRow {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number | string;
  width: number | null;
  height: number | null;
  s3_key: string;
  content_hash: string | null;
}

function mediaHeaders(classification: MediaClassification): Record<string, string> {
  return {
    'X-Detected-Mime': classification.detectedMime,
    'X-Media-Kind': classification.mediaKind,
    'X-Is-Text': classification.isText ? 'true' : 'false',
    ...(classification.textEncoding != null ? { 'X-Text-Encoding': classification.textEncoding } : {}),
  };
}

function uploadArtifactFilename(filename: string): string {
  const base = basename(filename.replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') return 'file';
  const cleaned = sanitizeFilename(base);
  return cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

function uploadArtifactPath(channelId: string, filename: string, suffix: number): string {
  if (suffix <= 1) return `shared/channels/${channelId}/uploads/${filename}`;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  return `shared/channels/${channelId}/uploads/${stem} (${suffix})${ext}`;
}

async function latestArtifactBlobByWorkspacePath(
  pool: Db,
  workspaceId: string,
  path: string,
): Promise<{ artifactId: string; blobSha: string | null } | null> {
  const res = await pool.query<{ id: string; blob_sha: string | null }>(
    `SELECT a.id, v.blob_sha
       FROM artifacts a
       LEFT JOIN artifact_pointers p ON p.artifact_id = a.id AND p.name = 'latest'
       LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.seq = p.seq
      WHERE a.workspace_id = $1 AND a.path = $2`,
    [workspaceId, path],
  );
  const row = res.rows[0];
  return row ? { artifactId: row.id, blobSha: row.blob_sha } : null;
}

async function landingPathForUpload(
  pool: Db,
  params: { workspaceId: string; channelId: string; filename: string; blobSha: string },
): Promise<string> {
  const filename = uploadArtifactFilename(params.filename);
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const path = uploadArtifactPath(params.channelId, filename, suffix);
    const existing = await latestArtifactBlobByWorkspacePath(pool, params.workspaceId, path);
    if (!existing || existing.blobSha === params.blobSha) return path;
  }
  throw new Error(`could not allocate upload artifact path for ${filename}`);
}

async function landUploadAttachmentAsArtifact(
  pool: Db,
  params: { channelId: string; userId: string; file: MessageAttachmentFileRow },
): Promise<void> {
  const channel = await pool.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM channels WHERE id = $1',
    [params.channelId],
  );
  const channelRow = channel.rows[0];
  if (!channelRow) throw new Error(`channel not found: ${params.channelId}`);

  const blobSha = params.file.content_hash;
  if (blobSha == null) throw new Error(`content_hash missing for file ${params.file.id}`);
  const sizeBytes = Number(params.file.size_bytes);
  const classification = classifyMediaFromMime(params.file.content_type);
  await pool.query(
    `INSERT INTO cas_blobs
       (sha256, s3_key, size_bytes, mime, detected_mime, media_kind, is_text, text_encoding, classification_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (sha256) DO UPDATE
           SET s3_key = COALESCE(cas_blobs.s3_key, EXCLUDED.s3_key),
               detected_mime = COALESCE(cas_blobs.detected_mime, EXCLUDED.detected_mime),
               media_kind = COALESCE(cas_blobs.media_kind, EXCLUDED.media_kind),
               is_text = COALESCE(cas_blobs.is_text, EXCLUDED.is_text),
               text_encoding = COALESCE(cas_blobs.text_encoding, EXCLUDED.text_encoding)`,
    [
      blobSha,
      params.file.s3_key,
      sizeBytes,
      params.file.content_type,
      classification.detectedMime,
      classification.mediaKind,
      classification.isText,
      classification.textEncoding,
      JSON.stringify(classification.meta),
    ],
  );

  const path = await landingPathForUpload(pool, {
    workspaceId: channelRow.workspace_id,
    channelId: params.channelId,
    filename: params.file.filename,
    blobSha,
  });
  await new ArtifactLedger(pool).commitUpload({
    workspaceId: channelRow.workspace_id,
    channelId: params.channelId,
    path,
    blobSha,
    sizeBytes,
    mime: params.file.content_type,
    author: `human:${params.userId}`,
  });
}

function parseBaseSeq(value: string | undefined): number | null | false {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : false;
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
  const calls =
    deps.calls === false ? null : (deps.calls ?? createLiveKitTokenService(config));
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
        message:
          typeof error.message === 'string' && error.message.length > 0
            ? error.message
            : 'rate limit exceeded',
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
        .query(`UPDATE auth_sessions SET expires_at = now() + interval '30 days' WHERE id = $1`, [
          sessionId,
        ])
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

  function prefsPatch(input: Record<string, unknown>): Partial<UserPrefs> {
    const patch: Partial<UserPrefs> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!(key in DEFAULT_PREFS)) continue;
      const prefKey = key as keyof UserPrefs;
      if (Object.is(normalizePrefs({ [key]: value })[prefKey], value)) {
        (patch as Record<keyof UserPrefs, UserPrefs[keyof UserPrefs]>)[prefKey] =
          value as UserPrefs[keyof UserPrefs];
      }
    }
    return patch;
  }

  function parseVoicePost(
    input: unknown,
    attachments: AttachmentMeta[] | undefined,
  ): { durationMs: number; waveform?: number[] } | undefined {
    if (input == null) return undefined;
    if (!isPlainObject(input)) {
      throw new DomainError(400, 'bad_voice', 'voice must be an object');
    }
    const durationMs = Number(input.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new DomainError(400, 'bad_voice', 'voice.durationMs must be a positive number');
    }
    // A voice message references exactly one attachment (the audio). Accept
    // audio/* or the generic octet-stream some browsers report for MediaRecorder
    // blobs — don't reject on brittle content-type sniffing.
    const ct = attachments?.[0]?.contentType.toLowerCase() ?? '';
    if (attachments?.length !== 1 || !(ct.startsWith('audio/') || ct === 'application/octet-stream')) {
      throw new DomainError(400, 'bad_voice', 'voice messages require exactly one audio attachment');
    }
    const waveform = Array.isArray(input.waveform)
      ? input.waveform.slice(0, 256).map((value) => {
          const n = Number(value);
          if (!Number.isFinite(n)) return 0;
          return Math.min(1, Math.max(0, n));
        })
      : undefined;
    return { durationMs, ...(waveform && waveform.length > 0 ? { waveform } : {}) };
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
    const res = await pool.query<{ raw_access: boolean }>(
      `SELECT raw_access FROM users WHERE id = $1`,
      [userId],
    );
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

  function withoutOpId(body: Record<string, unknown>): Record<string, unknown> {
    const rest = { ...body };
    delete rest.opId;
    return rest;
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
    const prefs = await client.query<{ prefs: unknown }>('SELECT prefs FROM users WHERE id = $1', [
      userId,
    ]);
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

  function codeHash(email: string, code: string): string {
    return createHmac('sha256', secret).update(`${email}:${code}`).digest('base64url');
  }

  function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  async function createAuthSession(
    reply: FastifyReply,
    user: { id: string; handle: string; display_name: string },
  ) {
    // Opportunistic reaping — keeps the table from accumulating dead rows.
    void pool.query('DELETE FROM auth_sessions WHERE expires_at < now()').catch(() => {});
    const session = await pool.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, expires_at)
       VALUES ($1, now() + interval '30 days') RETURNING id`,
      [user.id],
    );
    const token = signSession(session.rows[0]!.id, secret);
    reply.setCookie(config.sessionCookie, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return {
      user: { id: user.id, handle: user.handle, displayName: user.display_name },
      token,
    };
  }

  function normalizeEmail(input: unknown): string {
    return String(input ?? '').trim().toLowerCase();
  }

  function displayNameFromEmail(email: string): string {
    return email.split('@')[0] || email;
  }

  function handleBaseFromEmail(email: string): string {
    const local = displayNameFromEmail(email).toLowerCase();
    let handle = local
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/-+/g, '-')
      .slice(0, 32);
    if (!/^[a-z0-9]/.test(handle)) handle = 'user';
    if (handle.length < 2) handle = `${handle}x`;
    return handle;
  }

  async function joinDefaultWorkspace(userId: string): Promise<void> {
    const workspace = await ensureDefaultWorkspace(pool);
    await addWorkspaceMember(pool, workspace.id, userId);
  }

  async function activeWorkspaceIdFor(userId: string): Promise<string | null> {
    return (await workspaceIdsFor(pool, userId))[0] ?? null;
  }

  function noWorkspace(reply: FastifyReply) {
    return reply.code(403).send({ error: 'no_workspace', message: 'user has no workspace' });
  }

  function callsUnconfigured(reply: FastifyReply) {
    return reply
      .code(503)
      .send({ error: 'calls_unconfigured', message: 'voice calls are not configured' });
  }

  async function channelRecipientIds(client: DbClient, channelId: string): Promise<string[]> {
    const channel = await client.query<{ workspace_id: string; kind: string }>(
      'SELECT workspace_id, kind FROM channels WHERE id = $1',
      [channelId],
    );
    const row = channel.rows[0];
    if (!row) return [];
    if (row.kind === 'public') {
      return workspaceMemberIds(client, row.workspace_id);
    }
    const members = await client.query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1',
      [channelId],
    );
    return members.rows.map((member) => member.user_id);
  }

  async function canAccessChannelInTx(
    client: DbClient,
    userId: string,
    channelId: string,
  ): Promise<boolean> {
    const res = await client.query<{ member: boolean }>(
      `SELECT CASE WHEN c.kind = 'public' THEN ${workspaceMemberExists('c.workspace_id', '$2')}
                   ELSE EXISTS (SELECT 1 FROM channel_members m
                                WHERE m.channel_id = c.id AND m.user_id = $2)
              END AS member
       FROM channels c WHERE c.id = $1`,
      [channelId, userId],
    );
    return res.rows[0]?.member === true;
  }

  async function activeCallById(
    client: DbClient,
    callId: string,
  ): Promise<(CallRow & { channel_kind: 'public' | 'private' | 'dm' | 'gdm' }) | null> {
    const call = await client.query<CallRow & { channel_kind: 'public' | 'private' | 'dm' | 'gdm' }>(
      `SELECT calls.*, c.kind AS channel_kind
       FROM calls
       JOIN channels c ON c.id = calls.channel_id
       WHERE calls.id = $1 AND calls.status <> 'ended'
       FOR UPDATE OF calls`,
      [callId],
    );
    return call.rows[0] ?? null;
  }

  async function createUserForEmail(email: string) {
    const displayName = displayNameFromEmail(email);
    const base = handleBaseFromEmail(email).slice(0, 29);
    for (let i = 1; i <= 100; i += 1) {
      const suffix = i === 1 ? '' : `-${i}`;
      const handle = `${base.slice(0, 32 - suffix.length)}${suffix}`;
      const inserted = await pool.query<{ id: string; handle: string; display_name: string }>(
        `INSERT INTO users (handle, display_name, email)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id, handle, display_name`,
        [handle, displayName, email],
      );
      if (inserted.rows[0]) {
        await joinDefaultWorkspace(inserted.rows[0]!.id);
        return inserted.rows[0]!;
      }
      const existingEmail = await pool.query<{ id: string; handle: string; display_name: string }>(
        `SELECT id, handle, display_name FROM users WHERE email = $1`,
        [email],
      );
      if (existingEmail.rows[0]) return existingEmail.rows[0]!;
    }
    throw new Error('could not allocate handle');
  }

  async function userForEmail(email: string) {
    const existing = await pool.query<{ id: string; handle: string; display_name: string }>(
      `SELECT id, handle, display_name FROM users WHERE email = $1`,
      [email],
    );
    return existing.rows[0] ?? (await createUserForEmail(email));
  }

  function googleEnabled(): boolean {
    return Boolean(config.googleClientId && config.googleClientSecret && config.googleRedirectUrl);
  }

  function signOAuthState(): string {
    return signSession(`${Date.now()}:${randomUUID()}`, secret);
  }

  function verifyOAuthState(state: unknown): boolean {
    const payload = verifySession(typeof state === 'string' ? state : null, secret);
    if (!payload) return false;
    const [ts] = payload.split(':');
    const createdAt = Number(ts);
    return Number.isFinite(createdAt) && Date.now() - createdAt <= 10 * 60 * 1000;
  }

  async function userForGoogleIdentity(claims: {
    sub: string;
    email?: string;
    emailVerified: boolean;
    name?: string;
  }) {
    const linked = await pool.query<{ id: string; handle: string; display_name: string }>(
      `SELECT u.id, u.handle, u.display_name
       FROM oauth_identities oi JOIN users u ON u.id = oi.user_id
       WHERE oi.provider = 'google' AND oi.subject = $1`,
      [claims.sub],
    );
    if (linked.rows[0]) return linked.rows[0]!;

    let user: { id: string; handle: string; display_name: string };
    if (claims.email && claims.emailVerified) {
      const existing = await pool.query<{ id: string; handle: string; display_name: string }>(
        `SELECT id, handle, display_name FROM users WHERE email = $1`,
        [claims.email],
      );
      user = existing.rows[0] ?? (await createUserForEmail(claims.email));
    } else {
      user = await createUserForEmail(`${claims.sub}@google.oauth.local`);
    }

    await pool.query(
      `INSERT INTO oauth_identities (provider, subject, user_id)
       VALUES ('google', $1, $2)
       ON CONFLICT (provider, subject) DO NOTHING`,
      [claims.sub, user.id],
    );
    return user;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  app.get('/auth/methods', async () => {
    // First-run capability honesty: only advertise email when a user can
    // actually obtain a code — either dev-codes echo it in the response, or a
    // real (resend) transport delivers it. Plain "log" mode writes the code to
    // the server log only, so we don't offer it (the handle path leads instead).
    const emailUsable =
      config.authDevCodes ||
      (config.emailMode === 'resend' &&
        emailDeliveryConfigured({
          mode: config.emailMode,
          from: config.emailFrom,
          resendApiKey: config.resendApiKey,
        }));

    return {
      open: config.authOpen,
      email: emailUsable,
      google: googleEnabled(),
      // First-run capability honesty: LiveKit-less installs cannot start calls.
      calls: calls !== null,
    };
  });

  app.post(
    '/auth/email/request',
    {
      config: { rateLimit: rateLimit === false ? false : { max: 6 } },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { email?: string };
      const email = normalizeEmail(body.email);
      if (!EMAIL_RE.test(email) || email.length > 320) {
        return reply
          .code(400)
          .send({ error: 'invalid_email', message: 'enter a valid email address' });
      }
      // Per-email cooldown: ignore rapid repeats (don't churn the pending code
      // or spam delivery) while keeping the response uniform so it can't be
      // used to probe which emails are active.
      const recent = await pool.query(
        `SELECT 1 FROM login_codes WHERE email = $1 AND created_at > now() - interval '30 seconds' LIMIT 1`,
        [email],
      );
      if (recent.rowCount) return { ok: true };
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await pool.query('UPDATE login_codes SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL', [
        email,
      ]);
      await pool.query(
        `INSERT INTO login_codes (email, code_hash, expires_at)
         VALUES ($1, $2, now() + interval '10 minutes')`,
        [email, codeHash(email, code)],
      );
      // Deliver via the configured transport. A delivery failure is logged but
      // never changes the response — the reply must not reveal whether the
      // address is registered or whether sending succeeded. The actual code is
      // only logged when dev codes are explicitly enabled.
      try {
        await sendLoginCode(email, code, {
          config: {
            mode: config.emailMode,
            from: config.emailFrom,
            resendApiKey: config.resendApiKey,
          },
          fetchImpl: emailFetch,
          logCode: config.authDevCodes
            ? (to, c) => req.log.warn({ email: to, code: c }, 'auth email code (dev)')
            : undefined,
        });
      } catch (err) {
        req.log.error({ err, email }, 'login code delivery failed');
      }
      return config.authDevCodes ? { ok: true, devCode: code } : { ok: true };
    },
  );

  app.post('/auth/email/verify', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; code?: string };
    const email = normalizeEmail(body.email);
    const code = String(body.code ?? '').trim();
    if (!EMAIL_RE.test(email) || email.length > 320 || !CODE_RE.test(code)) {
      return reply.code(400).send({ error: 'invalid_code', message: 'invalid email code' });
    }
    // Atomic single-use redemption: consume the latest valid code ONLY if the
    // hash matches, in one UPDATE. Concurrent verifies can't double-redeem or
    // race past the lockout (the row lock serializes them, and a second
    // correct guess sees consumed_at already set → rowCount 0).
    const consumed = await pool.query<{ id: string }>(
      `UPDATE login_codes SET consumed_at = now()
       WHERE id = (
         SELECT id FROM login_codes
         WHERE email = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
         ORDER BY created_at DESC LIMIT 1
       )
       AND code_hash = $2
       AND consumed_at IS NULL
       AND expires_at > now()
       AND attempts < 5
       RETURNING id`,
      [email, codeHash(email, code)],
    );
    if (consumed.rowCount === 1) {
      const user = await userForEmail(email);
      return createAuthSession(reply, user);
    }
    // Wrong (or no valid) code: atomically burn an attempt on the latest valid
    // code, locking it after the 5th failure.
    await pool.query(
      `UPDATE login_codes
       SET attempts = attempts + 1,
           consumed_at = CASE WHEN attempts + 1 >= 5 THEN now() ELSE consumed_at END
       WHERE id = (
         SELECT id FROM login_codes
         WHERE email = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
         ORDER BY created_at DESC LIMIT 1
       )
       AND consumed_at IS NULL
       AND expires_at > now()
       AND attempts < 5`,
      [email],
    );
    return reply.code(400).send({ error: 'invalid_code', message: 'invalid email code' });
  });

  const OAUTH_STATE_COOKIE = 'atrium_oauth_state';

  app.get('/auth/oauth/google', async (_req, reply) => {
    if (!googleEnabled()) return reply.code(404).send({ error: 'not_found' });
    const state = signOAuthState();
    // Bind the state to THIS browser: the callback requires the same value
    // back in an httpOnly cookie, so a valid signed state can't be replayed
    // into a victim's session (login CSRF).
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/auth/oauth',
      maxAge: 600,
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', config.googleClientId);
    url.searchParams.set('redirect_uri', config.googleRedirectUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    return reply.redirect(url.toString(), 302);
  });

  app.get('/auth/oauth/google/callback', async (req, reply) => {
    if (!googleEnabled()) return reply.code(404).send({ error: 'not_found' });
    const query = req.query as { code?: string; state?: string };
    const cookieState = req.cookies[OAUTH_STATE_COOKIE];
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/oauth' });
    if (
      !query.code ||
      !verifyOAuthState(query.state) ||
      !cookieState ||
      query.state !== cookieState
    ) {
      return reply.code(400).send({ error: 'invalid_oauth_state' });
    }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: query.code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: config.googleRedirectUrl,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return reply.code(400).send({ error: 'oauth_exchange_failed' });
    const tokenBody = (await tokenRes.json()) as { id_token?: string };
    if (!tokenBody.id_token) return reply.code(400).send({ error: 'invalid_id_token' });
    // Verify the id_token's SIGNATURE via Google's tokeninfo endpoint (server-
    // side validation, no JWKS to hand-roll). The returned claims are trusted.
    const infoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenBody.id_token)}`,
    );
    if (!infoRes.ok) return reply.code(400).send({ error: 'invalid_id_token' });
    const claims = (await infoRes.json()) as Record<string, unknown>;
    const exp = Number(claims.exp);
    if (
      typeof claims.sub !== 'string' ||
      claims.aud !== config.googleClientId ||
      typeof claims.iss !== 'string' ||
      !GOOGLE_ISSUERS.has(claims.iss) ||
      !Number.isFinite(exp) ||
      exp * 1000 <= Date.now()
    ) {
      return reply.code(400).send({ error: 'invalid_id_token' });
    }
    const email = typeof claims.email === 'string' ? normalizeEmail(claims.email) : undefined;
    const user = await userForGoogleIdentity({
      sub: claims.sub,
      email,
      // tokeninfo returns claim values as strings ("true"); the token-exchange
      // path returned a boolean — accept both.
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      name: typeof claims.name === 'string' ? claims.name : undefined,
    });
    await createAuthSession(reply, user);
    return reply.redirect('/', 302);
  });

  app.post(
    '/auth/login',
    {
      config: { rateLimit: rateLimit === false ? false : { max: rateLimit?.loginMax ?? 30 } },
    },
    async (req, reply) => {
      if (!config.authOpen) {
        return reply.code(403).send({ error: 'auth_closed' });
      }
      const body = (req.body ?? {}) as { handle?: string; displayName?: string };
      const handle = String(body.handle ?? '').trim().toLowerCase();
      const displayName = String(body.displayName ?? '').trim();
      if (!HANDLE_RE.test(handle)) {
        return reply.code(400).send({
          error: 'invalid_handle',
          message: 'handle must be 2-32 chars: letters, digits, - or _',
        });
      }
      if (displayName.length > 64) {
        return reply
          .code(400)
          .send({ error: 'invalid_display_name', message: 'display name too long' });
      }
      // A blank display name means "keep what I had" for returning users —
      // re-logins must not silently rewrite attribution across history.
      let user = await pool.query<{ id: string; handle: string; display_name: string }>(
        `INSERT INTO users (handle, display_name) VALUES ($1, COALESCE(NULLIF($2, ''), $1))
         ON CONFLICT DO NOTHING
         RETURNING id, handle, display_name`,
        [handle, displayName],
      );
      if (user.rows[0]) {
        await joinDefaultWorkspace(user.rows[0].id);
      } else {
        user = await pool.query<{ id: string; handle: string; display_name: string }>(
          `UPDATE users
           SET display_name = COALESCE(NULLIF($2, ''), display_name)
           WHERE handle = $1
           RETURNING id, handle, display_name`,
          [handle, displayName],
        );
      }
      const u = user.rows[0]!;
      // Native clients can't rely on cookies — they store the token and send it
      // as `Authorization: Bearer` (HTTP) or `?token=` (WS upgrade).
      return createAuthSession(reply, u);
    },
  );

  app.get('/auth/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const res = await pool.query<{ prefs: unknown }>('SELECT prefs FROM users WHERE id = $1', [
      user.id,
    ]);
    return { user, prefs: normalizePrefs(res.rows[0]?.prefs) };
  });

  app.get('/api/me/provider-credentials', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { providers: await providerCredentials.list(user.id) };
  });

  app.put('/api/me/provider-credentials/claude-code', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) {
      return reply.code(400).send({ error: 'bad_request', message: 'Claude token required' });
    }
    const provider = await providerCredentials.upsertClaudeToken(user.id, token);
    await sessionRuns.clearClaudeAuthRequired(user.id);
    return { provider };
  });

  app.put('/api/me/provider-credentials/codex', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { authJson?: unknown };
    const authJson = typeof body.authJson === 'string' ? body.authJson.trim() : '';
    if (!authJson) {
      return reply.code(400).send({ error: 'bad_request', message: 'Codex auth.json required' });
    }
    try {
      const provider = await providerCredentials.upsertCodexAuthJson(user.id, authJson);
      await sessionRuns.clearProviderAuthRequired(user.id, CODEX_PROVIDER);
      return { provider };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid Codex auth.json';
      return reply.code(400).send({ error: 'bad_request', message });
    }
  });

  app.delete('/api/me/provider-credentials/claude-code', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    await providerCredentials.deleteClaudeToken(user.id);
    return { ok: true };
  });

  app.delete('/api/me/provider-credentials/codex', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    await providerCredentials.deleteCodexAuthJson(user.id);
    return { ok: true };
  });

  app.get('/api/me/agent-profiles', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { profiles: await agentProfiles.listProfiles(user.id) };
  });

  app.post('/api/me/agent-profiles', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { provider?: unknown; name?: unknown };
    const provider = providerFromProfileValue(body.provider);
    if (!provider) {
      return reply.code(400).send({ error: 'bad_request', message: 'provider must be codex or claude-code' });
    }
    const name = typeof body.name === 'string' ? body.name : '';
    return { profile: await agentProfiles.createProfile(user.id, provider, name) };
  });

  app.get('/api/me/agent-profiles/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    return { profile: await agentProfiles.getProfile(user.id, id) };
  });

  app.post('/api/me/agent-profiles/:id/versions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    return { version: await agentProfiles.createVersion(user.id, id, req.body ?? {}) };
  });

  app.post('/api/me/agent-profiles/import-local', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { provider?: unknown; proposal?: unknown };
    const provider = providerFromProfileValue(body.provider);
    if (!provider) {
      return reply.code(400).send({ error: 'bad_request', message: 'provider must be codex or claude-code' });
    }
    return { proposal: await agentProfiles.createImportProposal(user.id, provider, body.proposal ?? req.body) };
  });

  app.post('/auth/logout', async (req, reply) => {
    const sessionId = verifySession(rawSession(req), secret);
    if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) {
      await pool.query('DELETE FROM auth_sessions WHERE id = $1', [sessionId]);
    }
    reply.clearCookie(config.sessionCookie, { path: '/' });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Workspaces & channels
  // -------------------------------------------------------------------------

  app.get('/api/workspaces', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const res = await pool.query<{ id: string; name: string; created_at: Date }>(
      `SELECT w.id, w.name, w.created_at
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = $1
       ORDER BY wm.created_at ASC, w.id ASC`,
      [user.id],
    );
    return {
      workspaces: res.rows.map(
        (r): Workspace => ({
          id: r.id,
          name: r.name,
          createdAt: new Date(r.created_at).toISOString(),
        }),
      ),
    };
  });

  app.post('/api/workspaces', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { name?: unknown };
    const name = String(body.name ?? '').trim();
    if (name.length < 1 || name.length > 64) {
      return reply
        .code(400)
        .send({ error: 'invalid_workspace_name', message: 'workspace name must be 1-64 chars' });
    }
    try {
      const { workspace } = await createWorkspace(pool, { name, actorId: user.id });
      await addWorkspaceMember(pool, workspace.id, user.id);
      return reply.code(201).send({ workspace });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply
          .code(409)
          .send({ error: 'workspace_exists', message: 'workspace name already exists' });
      }
      throw err;
    }
  });

  app.post('/api/workspaces/:id/members', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!isUuid(id) || !(await isWorkspaceMember(pool, user.id, id))) {
      return reply.code(404).send({ error: 'workspace_not_found', message: 'workspace not found' });
    }
    const body = (req.body ?? {}) as { handle?: unknown };
    const handle = String(body.handle ?? '').trim().toLowerCase();
    const target = await pool.query<{ id: string; handle: string; display_name: string }>(
      'SELECT id, handle, display_name FROM users WHERE handle = $1',
      [handle],
    );
    const member = target.rows[0];
    if (!member) {
      return reply.code(404).send({ error: 'user_not_found', message: 'user not found' });
    }
    await addWorkspaceMember(pool, id, member.id);
    return {
      member: { id: member.id, handle: member.handle, displayName: member.display_name },
    };
  });

  app.get('/api/channels', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { channels: await listChannelsFor(pool, user.id) };
  });

  app.get('/api/sync', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { after?: string; limit?: string };
    const after = q.after == null ? 0 : Number(q.after);
    const rawLimit = q.limit == null ? 500 : Number(q.limit);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(rawLimit) ||
      rawLimit <= 0
    ) {
      return reply
        .code(400)
        .send({ error: 'bad_query', message: 'after must be non-negative and limit positive' });
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

  app.post('/api/channels/:id/read', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { lastReadEventId?: number; opId?: unknown };
    const opId = optionalOpId(body);
    const lastReadEventId = Number(body.lastReadEventId);
    if (!Number.isSafeInteger(lastReadEventId) || lastReadEventId < 0) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'lastReadEventId must be a non-negative integer' });
    }
    if (!(await canAccessChannel(pool, user.id, id))) {
      // 404, not 403 — don't leak the existence of someone else's DM.
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    let advanced = false;
    return runMutation({
      userId: user.id,
      opId,
      opType: 'read.mark',
      body: { channelId: id, lastReadEventId },
      fn: async (client) => {
        const res = await client.query<{ last_read_event_id: string; advanced: boolean }>(
          `WITH previous AS (
             SELECT last_read_event_id
             FROM channel_read_cursors
             WHERE user_id = $1 AND channel_id = $2
           ), upsert AS (
             INSERT INTO channel_read_cursors (user_id, channel_id, last_read_event_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, channel_id) DO UPDATE
             SET last_read_event_id = GREATEST(
                   channel_read_cursors.last_read_event_id,
                   EXCLUDED.last_read_event_id
                 ),
                 updated_at = CASE
                   WHEN EXCLUDED.last_read_event_id > channel_read_cursors.last_read_event_id
                   THEN now()
                   ELSE channel_read_cursors.updated_at
                 END
             RETURNING last_read_event_id
           )
           SELECT upsert.last_read_event_id,
                  COALESCE((SELECT last_read_event_id FROM previous), 0) < upsert.last_read_event_id
                    AS advanced
           FROM upsert`,
          [user.id, id, lastReadEventId],
        );
        const stored = Number(res.rows[0]!.last_read_event_id);
        advanced = res.rows[0]!.advanced;
        return { lastReadEventId: stored };
      },
      onApplied: (response) => {
        if (advanced) {
          hub.sendToUsers([user.id], {
            type: 'read',
            channelId: id,
            lastReadEventId: response.lastReadEventId,
          });
        }
      },
    });
  });

  app.post('/api/channels/:id/mute', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { muted?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.muted !== 'boolean') {
      return reply.code(400).send({ error: 'bad_request', message: 'muted must be boolean' });
    }
    if (!(await canAccessChannel(pool, user.id, id))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'mute.set',
      body: { channelId: id, muted: body.muted },
      fn: async (client) => {
        if (body.muted) {
          await client.query(
            `INSERT INTO channel_mutes (user_id, channel_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id, channel_id) DO NOTHING`,
            [user.id, id],
          );
        } else {
          await client.query('DELETE FROM channel_mutes WHERE user_id = $1 AND channel_id = $2', [
            user.id,
            id,
          ]);
        }
        return { muted: body.muted as boolean };
      },
      onApplied: (response) => {
        hub.sendToUsers([user.id], { type: 'muted', channelId: id, muted: response.muted });
      },
    });
  });

  app.patch('/api/me/prefs', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!isPlainObject(req.body)) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be object' });
    }
    const prefsBody = req.body;
    const opId = optionalOpId(prefsBody);
    return runMutation({
      userId: user.id,
      opId,
      opType: 'prefs.patch',
      body: withoutOpId(prefsBody),
      fn: async (client) => {
        const current = await client.query<{ prefs: unknown }>('SELECT prefs FROM users WHERE id = $1', [
          user.id,
        ]);
        const merged = normalizePrefs({
          ...normalizePrefs(current.rows[0]?.prefs),
          ...prefsPatch(prefsBody),
        });
        await client.query('UPDATE users SET prefs = $1 WHERE id = $2', [
          JSON.stringify(merged),
          user.id,
        ]);
        return { prefs: merged };
      },
      onApplied: (response) => {
        hub.sendToUsers([user.id], { type: 'prefs', prefs: response.prefs });
      },
    });
  });

  app.put('/api/me/drafts/:draftKey', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!isPlainObject(req.body)) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be object' });
    }
    const { draftKey } = req.params as { draftKey: string };
    const body = req.body as { text?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.text !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'text is required' });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'draft.set',
      body: { draftKey, text: body.text },
      fn: async (client) => {
        if (body.text === '') {
          await client.query(
            `UPDATE user_drafts
             SET text = '', deleted_at = now(), updated_at = now()
             WHERE user_id = $1 AND draft_key = $2`,
            [user.id, draftKey],
          );
          return { ok: true as const };
        }
        await client.query(
          `INSERT INTO user_drafts (user_id, draft_key, text, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (user_id, draft_key)
           DO UPDATE SET text = EXCLUDED.text, updated_at = now(), deleted_at = NULL`,
          [user.id, draftKey, body.text],
        );
        return { ok: true as const };
      },
    });
  });

  app.get('/api/users', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { users: await listUsers(pool, user.id) };
  });

  app.post('/api/dms', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { userId?: string; userIds?: unknown };
    const userIds = Array.isArray(body.userIds)
      ? body.userIds.filter((id): id is string => typeof id === 'string')
      : body.userId && typeof body.userId === 'string'
        ? [body.userId]
        : [];
    const distinctUserIds = [...new Set(userIds)];
    if (distinctUserIds.length < 1 || distinctUserIds.length > 8) {
      return reply.code(400).send({ error: 'bad_request', message: 'userIds must contain 1-8 users' });
    }
    const existingUsers = await pool.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [
      distinctUserIds,
    ]);
    if (existingUsers.rows.length !== distinctUserIds.length) {
      return reply.code(404).send({ error: 'user_not_found', message: 'user not found' });
    }
    const workspaceId = await activeWorkspaceIdFor(user.id);
    if (!workspaceId) return noWorkspace(reply);
    const isOneToOne = new Set([user.id, ...distinctUserIds]).size <= 2;
    const { channel, created } = isOneToOne
      ? await getOrCreateDm(pool, {
          workspaceId,
          userIdA: user.id,
          userIdB: distinctUserIds[0]!,
        })
      : await getOrCreateGdm(pool, {
          workspaceId,
          creatorId: user.id,
          userIds: distinctUserIds,
        });
    if (created) {
      // Only members learn the DM/GDM exists.
      hub.publishToUsers(
        channel.members?.map((m) => m.id) ?? [user.id, ...distinctUserIds],
        {
          id: 0,
          workspaceId,
          channelId: channel.id,
          threadRootEventId: null,
          type: 'channel.created',
          actorId: user.id,
          payload: { name: channel.name, channel },
          createdAt: new Date().toISOString(),
          author: user,
        },
      );
    }
    return reply.code(created ? 201 : 200).send({ channel });
  });

  app.post('/api/channels', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { name?: string; private?: unknown };
    const name = String(body.name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!CHANNEL_RE.test(name)) {
      return reply.code(400).send({
        error: 'invalid_channel_name',
        message: 'channel name must be 1-32 chars: lowercase letters, digits, - or _',
      });
    }
    const workspaceId = await activeWorkspaceIdFor(user.id);
    if (!workspaceId) return noWorkspace(reply);
    const { channel, event } = await createChannel(pool, {
      workspaceId,
      name,
      actorId: user.id,
      private: body.private === true,
    });
    const createdEvent = { ...event, payload: { ...event.payload, channel } };
    if (channel.kind === 'public') {
      hub.publishToUsers(await workspaceMemberIds(pool, channel.workspaceId), createdEvent);
    } else {
      hub.publishToUsers([user.id], createdEvent);
    }
    return reply.code(201).send({ channel });
  });

  app.get('/api/channels/:id/members', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const result = await listChannelMembers(pool, { channelId: id, userId: user.id });
    if (!result) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return { members: result.members };
  });

  app.post('/api/channels/:id/members', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { userId?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.userId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'userId required' });
    }
    const response = await runMutation({
      userId: user.id,
      opId,
      opType: 'channel.member.add',
      body: { channelId: id, userId: body.userId },
      fn: async (client) => {
        const result = await addChannelMemberTx(client, {
          channelId: id,
          actorId: user.id,
          userId: body.userId as string,
        });
        if (!result) return null;
        return { member: result.member, channel: result.channel, event: result.event };
      },
      onApplied: (result) => {
        if (!result) return;
        hub.publishToUsers([body.userId as string], {
          id: 0,
          workspaceId: result.channel.workspaceId,
          channelId: result.channel.id,
          threadRootEventId: null,
          type: 'channel.created',
          actorId: user.id,
          payload: { name: result.channel.name, channel: result.channel },
          createdAt: new Date().toISOString(),
          author: user,
        });
        hub.publishEvent(result.event);
      },
    });
    if (!response) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return reply.code(201).send({ member: response.member });
  });

  app.delete('/api/channels/:id/members/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { opId?: unknown };
    const opId = optionalOpId(body);
    const response = await runMutation({
      userId: user.id,
      opId,
      opType: 'channel.leave',
      body: { channelId: id },
      fn: async (client) => {
        const result = await leaveChannelTx(client, { channelId: id, userId: user.id });
        if (!result) return null;
        return { ok: true as const, event: result.event };
      },
      onApplied: (result) => {
        if (!result) return;
        hub.publishEvent(result.event);
        hub.sendToUsers([user.id], { type: 'channel-left', channelId: id });
      },
    });
    if (!response) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Calls (LiveKit tokens + ephemeral WS signaling)
  // -------------------------------------------------------------------------

  app.post('/api/calls', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { channelId?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId required' });
    }
    if (!calls) return callsUnconfigured(reply);
    if (!(await canAccessChannel(pool, user.id, body.channelId))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }

    const response = await runMutation({
      userId: user.id,
      opId,
      opType: 'call.start',
      body: { channelId: body.channelId },
      fn: async (client) => {
        let created = false;
        const channel = await client.query<{ id: string; workspace_id: string }>(
          'SELECT id, workspace_id FROM channels WHERE id = $1 FOR UPDATE',
          [body.channelId],
        );
        const channelRow = channel.rows[0];
        if (!channelRow) {
          throw new DomainError(404, 'channel_not_found', 'channel not found');
        }
        const existing = await client.query<CallRow>(
          `SELECT * FROM calls
           WHERE channel_id = $1 AND status <> 'ended'
           ORDER BY started_at DESC
           LIMIT 1
           FOR UPDATE`,
          [body.channelId],
        );
        let call = existing.rows[0];
        if (!call) {
          const id = randomUUID();
          const inserted = await client.query<CallRow>(
            `INSERT INTO calls (id, workspace_id, channel_id, initiator_id, room, status)
             VALUES ($1, $2, $3, $4, $5, 'ringing')
             RETURNING *`,
            [id, channelRow.workspace_id, channelRow.id, user.id, `call:${id}`],
          );
          call = inserted.rows[0]!;
          created = true;
        }
        const existingParticipant = await client.query<{ left_at: Date | null }>(
          'SELECT left_at FROM call_participants WHERE call_id = $1 AND user_id = $2',
          [call.id, user.id],
        );
        const joinedNow =
          existingParticipant.rows.length === 0 || existingParticipant.rows[0]!.left_at != null;
        await client.query(
          `INSERT INTO call_participants (call_id, user_id, joined_at, left_at)
           VALUES ($1, $2, now(), NULL)
           ON CONFLICT (call_id, user_id) DO UPDATE
           SET joined_at = CASE
                 WHEN call_participants.left_at IS NULL THEN call_participants.joined_at
                 ELSE now()
               END,
               left_at = NULL`,
          [call.id, user.id],
        );
        // Promote to 'active' only when joining an EXISTING call; a freshly
        // created call stays 'ringing' so the call.ringing frame's embedded
        // status is honest (it flips to 'active' when a callee accepts).
        if (!created) {
          const updated = await client.query<CallRow>(
            `UPDATE calls SET status = 'active'
             WHERE id = $1 AND status <> 'ended'
             RETURNING *`,
            [call.id],
          );
          call = updated.rows[0]!;
        }
        const wire = await loadCallWire(client, call);
        const token = await calls.mintToken(call.room, user.id, user.displayName);
        return { join: { call: wire, token, url: calls.url }, created, joinedNow };
      },
      onApplied: async (result) => {
        const recipients = (await withTx(pool, (client) =>
          channelRecipientIds(client, result.join.call.channelId),
        ));
        if (result.created) {
          const ringRecipients = recipients.filter((id) => id !== user.id);
          hub.publishCallToUsers(
            ringRecipients,
            { type: 'call.ringing', call: result.join.call },
          );
          void sendIncomingCallVoipPushes(pool, voip, {
            recipientIds: ringRecipients,
            callId: result.join.call.id,
            callerId: user.id,
            callerName: user.displayName,
            channelId: result.join.call.channelId,
          }).catch((err) => {
            app.log.warn({ err }, 'voip push failed');
          });
        } else if (result.joinedNow) {
          hub.publishCallToUsers(recipients, {
            type: 'call.participant_joined',
            callId: result.join.call.id,
            user,
          });
        }
      },
    });
    return response.join;
  });

  app.post('/api/calls/:id/accept', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: 'call_not_found', message: 'call not found' });
    if (!calls) return callsUnconfigured(reply);

    const response = await withTx(pool, async (client) => {
      const call = await activeCallById(client, id);
      if (!call || !(await canAccessChannelInTx(client, user.id, call.channel_id))) {
        throw new DomainError(404, 'call_not_found', 'call not found');
      }
      await client.query(
        `INSERT INTO call_participants (call_id, user_id, joined_at, left_at)
         VALUES ($1, $2, now(), NULL)
         ON CONFLICT (call_id, user_id) DO UPDATE
         SET joined_at = CASE
               WHEN call_participants.left_at IS NULL THEN call_participants.joined_at
               ELSE now()
             END,
             left_at = NULL`,
        [call.id, user.id],
      );
      const updated = await client.query<CallRow>(
        `UPDATE calls SET status = 'active'
         WHERE id = $1 AND status <> 'ended'
         RETURNING *`,
        [call.id],
      );
      const current = updated.rows[0]!;
      const wire = await loadCallWire(client, current);
      const token = await calls.mintToken(current.room, user.id, user.displayName);
      return {
        join: { call: wire, token, url: calls.url },
        recipients: await channelRecipientIds(client, current.channel_id),
      };
    });
    hub.publishCallToUsers(response.recipients, {
      type: 'call.accepted',
      callId: response.join.call.id,
      user,
    });
    hub.publishCallToUsers(response.recipients, {
      type: 'call.participant_joined',
      callId: response.join.call.id,
      user,
    });
    return response.join;
  });

  app.post('/api/calls/:id/decline', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: 'call_not_found', message: 'call not found' });
    if (!calls) return callsUnconfigured(reply);

    const result = await withTx(pool, async (client) => {
      const call = await activeCallById(client, id);
      if (!call || !(await canAccessChannelInTx(client, user.id, call.channel_id))) {
        throw new DomainError(404, 'call_not_found', 'call not found');
      }
      const recipients = await channelRecipientIds(client, call.channel_id);
      // A DM call has exactly two people: either the callee declining or the
      // caller cancelling ends it (otherwise it would hang in 'ringing' forever
      // with no GC). Group/public declines just dismiss the ring locally.
      const shouldEnd = call.channel_kind === 'dm';
      if (shouldEnd) {
        await client.query(
          "UPDATE calls SET status = 'ended', ended_at = COALESCE(ended_at, now()) WHERE id = $1",
          [call.id],
        );
      }
      return { callId: call.id, recipients, ended: shouldEnd };
    });
    hub.publishCallToUsers(result.recipients, {
      type: 'call.declined',
      callId: result.callId,
      userId: user.id,
    });
    if (result.ended) {
      hub.publishCallToUsers(result.recipients, { type: 'call.ended', callId: result.callId });
    }
    return { ok: true };
  });

  app.post('/api/calls/:id/leave', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: 'call_not_found', message: 'call not found' });
    if (!calls) return callsUnconfigured(reply);

    const result = await withTx(pool, async (client) => {
      const call = await activeCallById(client, id);
      if (!call || !(await canAccessChannelInTx(client, user.id, call.channel_id))) {
        throw new DomainError(404, 'call_not_found', 'call not found');
      }
      const left = await client.query(
        `UPDATE call_participants
         SET left_at = now()
         WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL
         RETURNING 1`,
        [call.id, user.id],
      );
      // Not an active participant (never joined / already left): no-op, no signal.
      if ((left.rowCount ?? 0) === 0) {
        return { callId: call.id, recipients: [] as string[], ended: false, left: false };
      }
      const remaining = await client.query<{ count: string }>(
        'SELECT COUNT(*) FROM call_participants WHERE call_id = $1 AND left_at IS NULL',
        [call.id],
      );
      const ended = Number(remaining.rows[0]!.count) === 0;
      if (ended) {
        await client.query(
          "UPDATE calls SET status = 'ended', ended_at = COALESCE(ended_at, now()) WHERE id = $1",
          [call.id],
        );
      }
      return {
        callId: call.id,
        recipients: await channelRecipientIds(client, call.channel_id),
        ended,
        left: true,
      };
    });
    if (result.left) {
      hub.publishCallToUsers(result.recipients, {
        type: 'call.participant_left',
        callId: result.callId,
        userId: user.id,
      });
    }
    if (result.ended) {
      hub.publishCallToUsers(result.recipients, { type: 'call.ended', callId: result.callId });
    }
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  app.get('/api/channels/:id/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await canAccessChannel(pool, user.id, id))) {
      // 404, not 403 — don't leak the existence of someone else's DM.
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const q = req.query as { before_id?: string; after_id?: string; limit?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    const beforeId = q.before_id ? Number(q.before_id) : undefined;
    const afterId = q.after_id ? Number(q.after_id) : undefined;
    if ([limit, beforeId, afterId].some((v) => v !== undefined && !Number.isFinite(v))) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric query params expected' });
    }
    if (beforeId !== undefined && afterId !== undefined) {
      return reply.code(400).send({ error: 'bad_query', message: 'use before_id or after_id, not both' });
    }
    return listChannelMessages(pool, { channelId: id, beforeId, afterId, limit });
  });

  app.get('/api/entries/:handle', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { handle } = req.params as { handle: string };
    if (!tryDecodeHandle(handle)) {
      return reply.code(400).send({ error: 'bad_handle' });
    }
    const entry = await resolveEntry(pool, handle, user.id);
    if (!entry) {
      return reply.code(404).send({ error: 'entry_not_found' });
    }
    return entry;
  });

  app.get('/api/entries/:handle/annotations', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { handle } = req.params as { handle: string };
    if (!tryDecodeHandle(handle)) {
      return reply.code(400).send({ error: 'bad_handle' });
    }
    const entry = await resolveEntry(pool, handle, user.id);
    if (!entry) {
      return reply.code(404).send({ error: 'entry_not_found' });
    }
    return foldAnnotations(pool, handle);
  });

  app.post(
    '/api/entries/:handle/comments',
    { config: { rateLimit: entryAnnotationRateLimit } },
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      const { handle } = req.params as { handle: string };
      if (!tryDecodeHandle(handle)) {
        return reply.code(400).send({ error: 'bad_handle' });
      }
      const entry = await resolveEntry(pool, handle, user.id);
      if (!entry) {
        return reply.code(404).send({ error: 'entry_not_found' });
      }
      const body = (req.body ?? {}) as { text?: string; opId?: unknown; via?: unknown };
      const opId = optionalOpId(body);
      const text = typeof body.text === 'string' ? body.text : '';
      // Only 'agent' is honored; the MCP write tool sets it. Display tag, not a
      // trust boundary (the actor remains the real principal).
      const via = body.via === 'agent' ? ('agent' as const) : undefined;
      if (text.trim().length === 0) {
        return reply.code(400).send({ error: 'empty_comment', message: 'comment text is empty' });
      }
      if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
        return reply.code(413).send({ error: 'comment_too_large', message: 'comment exceeds 8KB' });
      }
      const response = await runMutation({
        userId: user.id,
        opId,
        opType: 'comment.post',
        body: { handle, text, via },
        fn: async (client) => {
          const event = await postCommentTx(client, { handle, actorId: user.id, text, via });
          return { event };
        },
        onApplied: (result) => {
          hub.publishEvent(result.event);
        },
      });
      return reply.code(201).send(response);
    },
  );

  app.post(
    '/api/entries/:handle/reactions',
    { config: { rateLimit: entryAnnotationRateLimit } },
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      const { handle } = req.params as { handle: string };
      if (!tryDecodeHandle(handle)) {
        return reply.code(400).send({ error: 'bad_handle' });
      }
      const body = (req.body ?? {}) as { emoji?: string; action?: unknown; opId?: unknown };
      const opId = optionalOpId(body);
      if (typeof body.emoji !== 'string' || !body.emoji) {
        return reply.code(400).send({ error: 'bad_request', message: 'emoji required' });
      }
      if (!(REACTION_EMOJI as readonly string[]).includes(body.emoji)) {
        return reply.code(400).send({ error: 'invalid_emoji', message: 'unsupported reaction emoji' });
      }
      if (body.action !== 'add' && body.action !== 'remove') {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: "action must be 'add' or 'remove'" });
      }
      const entry = await resolveEntry(pool, handle, user.id);
      if (!entry) {
        return reply.code(404).send({ error: 'entry_not_found' });
      }
      return runMutation({
        userId: user.id,
        opId,
        opType: 'entry.reaction.set',
        body: { handle, emoji: body.emoji, action: body.action },
        fn: async (client) => {
          const result = await setEntryReactionTx(client, {
            handle,
            actorId: user.id,
            emoji: body.emoji as string,
            action: body.action as ReactionAction,
          });
          return result.applied ? { event: result.event } : { event: null, applied: false as const };
        },
        onApplied: (response) => {
          if (response.event) hub.publishEvent(response.event);
        },
      });
    },
  );

  app.get('/api/search', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = (req.query as { q?: string; limit?: string });
    const query = String(q.q ?? '').trim();
    if (query.length < 2) {
      return reply.code(400).send({ error: 'bad_query', message: 'query must be at least 2 chars' });
    }
    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric limit expected' });
    }
    return { results: await searchMessages(pool, { query, userId: user.id, limit }) };
  });

  // === session-search additions (#72) ===
  app.get('/api/search/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { q?: string; kinds?: string; full?: string; limit?: string };
    const query = String(q.q ?? '').trim();
    if (query.length < 2) {
      return reply.code(400).send({ error: 'bad_query', message: 'query must be at least 2 chars' });
    }
    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric limit expected' });
    }
    const full = q.full === '1';
    if (full && !(await canViewFull(user.id))) {
      return fullViewForbidden(reply);
    }
    const kinds = q.kinds
      ?.split(',')
      .map((kind) => kind.trim())
      .filter((kind) => kind.length > 0);
    return {
      results: await searchSessionRecords(pool, {
        query,
        userId: user.id,
        kinds: kinds && kinds.length > 0 ? kinds : undefined,
        full,
        limit,
      }),
    };
  });

  app.get('/api/threads/:rootEventId/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const rootEventId = Number((req.params as { rootEventId: string }).rootEventId);
    if (!Number.isFinite(rootEventId)) {
      return reply.code(400).send({ error: 'bad_query', message: 'numeric root event id expected' });
    }
    const root = await pool.query<{ channel_id: string | null }>(
      'SELECT channel_id FROM events WHERE id = $1',
      [rootEventId],
    );
    const channelId = root.rows[0]?.channel_id;
    if (!channelId || !(await canAccessChannel(pool, user.id, channelId))) {
      return reply.code(404).send({ error: 'thread_not_found', message: 'thread not found' });
    }
    return listThreadMessages(pool, { rootEventId });
  });

  app.post('/api/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      channelId?: string;
      text?: string;
      clientMsgId?: string;
      threadRootEventId?: number;
      attachments?: unknown;
      voice?: unknown;
    };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!body.channelId || typeof body.channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId required' });
    }
    const attachmentIds = Array.isArray(body.attachments)
      ? body.attachments.filter((a): a is string => typeof a === 'string').slice(0, 10)
      : [];
    if (text.trim().length === 0 && attachmentIds.length === 0 && body.voice == null) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    let attachments: AttachmentMeta[] | undefined;
    let uploadAttachmentFiles: MessageAttachmentFileRow[] = [];
    if (attachmentIds.length > 0) {
      const rows = await pool.query<MessageAttachmentFileRow>(
        `SELECT id, filename, content_type, size_bytes, width, height, s3_key, content_hash
         FROM files WHERE id = ANY($1::uuid[]) AND uploader_id = $2`,
        [attachmentIds, user.id],
      );
      if (rows.rows.length !== attachmentIds.length) {
        return reply
          .code(400)
          .send({ error: 'bad_attachment', message: 'unknown or foreign attachment id' });
      }
      const fileById = new Map(rows.rows.map((row) => [row.id, row]));
      uploadAttachmentFiles = attachmentIds.map((id) => fileById.get(id)!);
      attachments = uploadAttachmentFiles.map((f) => {
        return {
          id: f.id,
          filename: f.filename,
          contentType: f.content_type,
          size: Number(f.size_bytes),
          ...(f.width != null ? { width: f.width } : {}),
          ...(f.height != null ? { height: f.height } : {}),
        };
      });
    }
    const clientMsgId =
      typeof body.clientMsgId === 'string' && body.clientMsgId.length <= 64
        ? body.clientMsgId
        : null;
    const threadRootEventId =
      body.threadRootEventId != null ? Number(body.threadRootEventId) : null;
    if (threadRootEventId !== null && !Number.isFinite(threadRootEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'threadRootEventId must be numeric' });
    }
    const voice = parseVoicePost(body.voice, attachments);
    const channel = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM channels WHERE id = $1',
      [body.channelId],
    );
    if (!channel.rows[0] || !(await canAccessChannel(pool, user.id, body.channelId))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const event = await postMessage(pool, {
      workspaceId: channel.rows[0].workspace_id,
      channelId: body.channelId,
      actorId: user.id,
      text,
      clientMsgId,
      threadRootEventId,
      attachments,
      voice,
    });
    hub.publishEvent(event);
    for (const file of uploadAttachmentFiles) {
      if (file.content_hash == null) {
        app.log.warn(
          { fileId: file.id, filename: file.filename },
          'upload attachment artifact landing skipped: missing content_hash',
        );
        continue;
      }
      try {
        await landUploadAttachmentAsArtifact(pool, {
          channelId: body.channelId,
          userId: user.id,
          file,
        });
      } catch (err) {
        app.log.warn(
          { err, fileId: file.id, filename: file.filename },
          'upload attachment artifact landing failed',
        );
      }
    }
    if (voice) deps.stt?.enqueue();
    void sendMessagePush(pool, hub, event).catch((err) =>
      app.log.warn({ err }, 'push fanout failed'),
    );
    return reply.code(201).send({ event });
  });

  // Re-run STT for a voice message whose transcript landed in `failed`. Resets
  // the queue row (attempts back to 0 so the worker re-claims it), broadcasts a
  // `pending` transcript so every client flips back to a loading state, then
  // nudges the in-process worker. The eventual done/failed arrives over the WS.
  app.post('/api/voice/:fileId/retranscribe', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { fileId } = req.params as { fileId: string };
    const tr = await pool.query<{ channel_id: string | null; event_id: number; status: string }>(
      'SELECT channel_id, event_id, status FROM transcripts WHERE file_id = $1',
      [fileId],
    );
    const row = tr.rows[0];
    // Collapse "not found" and "no access" into one response so a transcript's
    // existence can't be probed by a non-member.
    if (!row || !row.channel_id || !(await canAccessChannel(pool, user.id, row.channel_id))) {
      return reply.code(404).send({ error: 'not_found', message: 'transcript not found' });
    }
    if (row.status !== 'failed') {
      return reply
        .code(409)
        .send({ error: 'not_retryable', message: 'transcript is not in a failed state' });
    }
    const event = await withTx(pool, async (client) => {
      await client.query(
        `UPDATE transcripts
         SET status = 'pending', attempts = 0, error = NULL, updated_at = now()
         WHERE file_id = $1`,
        [fileId],
      );
      return appendVoiceTranscribedEventTx(client, {
        targetEventId: row.event_id,
        transcript: { status: 'pending' },
      });
    });
    hub.publishEvent(event);
    deps.stt?.enqueue();
    return reply.code(202).send({ event });
  });

  app.patch('/api/messages/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const body = (req.body ?? {}) as { text?: string; opId?: unknown };
    const opId = optionalOpId(body);
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_message', message: 'message text is empty' });
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'message_too_large', message: 'message exceeds 8KB' });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'message.edit',
      body: { targetEventId, text },
      fn: async (client) => {
        const event = await editMessageTx(client, { targetEventId, actorId: user.id, text });
        return { event };
      },
      onApplied: (response) => {
        hub.publishEvent(response.event);
      },
    });
  });

  app.delete('/api/messages/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const body = (req.body ?? {}) as { opId?: unknown };
    const opId = optionalOpId(body);
    return runMutation({
      userId: user.id,
      opId,
      opType: 'message.delete',
      body: { targetEventId },
      fn: async (client) => {
        const event = await deleteMessageTx(client, { targetEventId, actorId: user.id });
        return { event };
      },
      onApplied: (response) => {
        hub.publishEvent(response.event);
      },
    });
  });

  // -------------------------------------------------------------------------
  // File uploads (presigned to S3/MinIO)
  // -------------------------------------------------------------------------

  app.post('/api/uploads', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      filename?: string;
      contentType?: string;
      size?: number;
      width?: number;
      height?: number;
      contentHash?: string;
    };
    const filename = String(body.filename ?? '').trim().slice(0, 200) || 'file';
    const contentType =
      typeof body.contentType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(body.contentType)
        ? body.contentType
        : 'application/octet-stream';
    const contentHash =
      typeof body.contentHash === 'string' && body.contentHash.length > 0
        ? body.contentHash.toLowerCase()
        : null;
    if (contentHash != null && !/^[0-9a-f]{64}$/.test(contentHash)) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'contentHash must be sha-256 hex' });
    }
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'size required' });
    }
    if (size > config.maxUploadBytes) {
      return reply.code(413).send({
        error: 'file_too_large',
        message: `file exceeds ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB`,
      });
    }
    const dim = (v: unknown) =>
      Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null;
    const workspaceId = await activeWorkspaceIdFor(user.id);
    if (!workspaceId) return noWorkspace(reply);
    try {
      await fileStorage.ensureBucket();
    } catch {
      return reply
        .code(503)
        .send({ error: 'storage_unavailable', message: 'file storage is not running' });
    }

    if (contentHash != null) {
      const existing = await pool.query<{ id: string; s3_key: string }>(
        `SELECT id, s3_key
           FROM files
          WHERE uploader_id = $1 AND content_hash = $2 AND size_bytes = $3
          ORDER BY created_at ASC
          LIMIT 1`,
        [user.id, contentHash, size],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        const uploadUrl = await fileStorage.presignPut(row.s3_key, contentType);
        return reply.send({ fileId: row.id, uploadUrl, existing: true });
      }
    }

    const fileId = randomUUID();
    const s3Key = `${fileId}/${filename}`;
    await pool.query(
      `INSERT INTO files (id, workspace_id, uploader_id, filename, content_type, size_bytes, width, height, s3_key, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        fileId,
        workspaceId,
        user.id,
        filename,
        contentType,
        size,
        dim(body.width),
        dim(body.height),
        s3Key,
        contentHash,
      ],
    );
    const uploadUrl = await fileStorage.presignPut(s3Key, contentType);
    return reply.code(201).send({ fileId, uploadUrl, existing: false });
  });

  // === writeback route ===
  await app.register(async (writeback) => {
    writeback.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: config.maxUploadBytes },
      (_req, body, done) => done(null, body),
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
      const session = await pool.query<{ id: string }>(
        `SELECT id FROM sessions WHERE id = $1 AND channel_id = $2`,
        [sessionId, channelId],
      );
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
        return reply.code(400).send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
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

  app.post('/api/uploads/:fileId/refresh', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { fileId } = req.params as { fileId: string };
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    const row = await pool.query<{ content_type: string; s3_key: string }>(
      `SELECT content_type, s3_key FROM files WHERE id = $1 AND uploader_id = $2`,
      [fileId, user.id],
    );
    const file = row.rows[0];
    if (!file) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    try {
      await fileStorage.ensureBucket();
    } catch {
      return reply
        .code(503)
        .send({ error: 'storage_unavailable', message: 'file storage is not running' });
    }
    const uploadUrl = await fileStorage.presignPut(file.s3_key, file.content_type);
    return reply.send({ uploadUrl });
  });

  // Mint a short-lived signed URL for opening a file outside an authenticated
  // context (external browser, share sheet). File-scoped — never the session.
  app.get('/api/files/:id/url', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    if (!(await canAccessFile(pool, user.id, id))) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    const expires = Math.floor(Date.now() / 1000) + FILE_URL_TTL_S;
    const sig = fileSignature(id, expires, secret);
    return {
      url: `/api/files/${id}?expires=${expires}&sig=${encodeURIComponent(sig)}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  });

  app.get('/api/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    // Either a valid short-lived file signature (the capability was minted by
    // someone with access via /api/files/:id/url) or a logged-in caller who
    // can access a channel the file is attached to. The signed path is the
    // mobile/in-app image hot path's sibling; the authed path gates on
    // canAccessFile so a non-member can't pull a file by its id.
    const q = (req.query ?? {}) as { expires?: unknown; sig?: unknown };
    const signed =
      typeof q.sig === 'string' &&
      typeof q.expires === 'string' &&
      verifyFileSignature(id, Number(q.expires), q.sig, secret);
    if (!signed) {
      const user = requireUser(req, reply);
      if (!user) return;
      if (!(await canAccessFile(pool, user.id, id))) {
        return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
      }
    }
    const res = await pool.query<{
      filename: string;
      content_type: string;
      s3_key: string;
    }>('SELECT filename, content_type, s3_key FROM files WHERE id = $1', [id]);
    const file = res.rows[0];
    if (!file || !file.s3_key) {
      return reply.code(404).send({ error: 'file_not_found', message: 'file not found' });
    }
    const inline =
      file.content_type.startsWith('image/') || file.content_type === 'application/pdf';
    const url = await fileStorage.presignGet(file.s3_key, file.filename, inline);
    return reply.redirect(url, 302);
  });

  app.post('/api/messages/:id/reactions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const targetEventId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(targetEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'numeric message id expected' });
    }
    const body = (req.body ?? {}) as { emoji?: string; action?: unknown; opId?: unknown };
    const opId = optionalOpId(body);
    if (typeof body.emoji !== 'string' || !body.emoji) {
      return reply.code(400).send({ error: 'bad_request', message: 'emoji required' });
    }
    if (body.action !== 'add' && body.action !== 'remove') {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: "action must be 'add' or 'remove'" });
    }
    return runMutation({
      userId: user.id,
      opId,
      opType: 'reaction.set',
      body: { targetEventId, emoji: body.emoji, action: body.action },
      fn: async (client) => {
        const result = await setReactionTx(client, {
          targetEventId,
          actorId: user.id,
          emoji: body.emoji as string,
          action: body.action as ReactionAction,
        });
        return result.applied ? { event: result.event } : { event: null, applied: false as const };
      },
      onApplied: (response) => {
        if (response.event) hub.publishEvent(response.event);
      },
    });
  });

  // -------------------------------------------------------------------------
  // Agent sessions
  // -------------------------------------------------------------------------

  app.post('/api/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      channelId?: string;
      threadRootEventId?: number;
      task?: string;
      harness?: string;
      repo?: string;
      branch?: string;
      agentProfileId?: string;
      agentProfileVersionId?: string;
      opId?: unknown;
    };
    const opId = optionalOpId(body);
    const task = typeof body.task === 'string' ? body.task : '';
    const repo = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : undefined;
    const branch =
      typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : undefined;
    if (!body.channelId || typeof body.channelId !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'channelId required' });
    }
    if (task.trim().length === 0) {
      return reply.code(400).send({ error: 'empty_task', message: 'task is empty' });
    }
    if (Buffer.byteLength(task, 'utf8') > config.maxMessageBytes) {
      return reply.code(413).send({ error: 'task_too_large', message: 'task exceeds 8KB' });
    }
    const threadRootEventId =
      body.threadRootEventId != null ? Number(body.threadRootEventId) : null;
    if (threadRootEventId !== null && !Number.isFinite(threadRootEventId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'threadRootEventId must be numeric' });
    }
    if (!(await canAccessChannel(pool, user.id, body.channelId))) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }
    const bodySpawnId = (body as { clientSpawnId?: unknown }).clientSpawnId;
    const clientSpawnId =
      typeof bodySpawnId === 'string' && bodySpawnId.length <= 80 ? bodySpawnId : undefined;
    const agentProfileId =
      typeof body.agentProfileId === 'string' && body.agentProfileId.trim()
        ? body.agentProfileId.trim()
        : undefined;
    const agentProfileVersionId =
      typeof body.agentProfileVersionId === 'string' && body.agentProfileVersionId.trim()
        ? body.agentProfileVersionId.trim()
        : undefined;
    let createdSession: Awaited<ReturnType<typeof sessionRuns.createSessionInTx>> | null = null;
    const result = await runMutation({
      userId: user.id,
      opId,
      opType: 'session.spawn',
      body: {
        channelId: body.channelId,
        threadRootEventId,
        task,
        harness: typeof body.harness === 'string' && body.harness.trim() ? body.harness.trim() : undefined,
        repo,
        branch,
        agentProfileId,
        agentProfileVersionId,
        clientSpawnId,
      },
      fn: async (client) => {
        createdSession = await sessionRuns.createSessionInTx(client, {
          channelId: body.channelId as string,
          threadRootEventId,
          task,
          harness:
            typeof body.harness === 'string' && body.harness.trim() ? body.harness.trim() : undefined,
          repo,
          branch,
          agentProfileId,
          agentProfileVersionId,
          clientSpawnId,
          user,
        });
        return { session: createdSession.session, created: createdSession.created };
      },
      onApplied: () => {
        if (createdSession) sessionRuns.afterCreateSession(createdSession, task);
      },
    });
    return reply.code(result.created ? 201 : 200).send({ session: result.session });
  });

  app.get('/api/sessions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { status?: string; limit?: string };
    const status =
      q.status === 'running' || q.status === 'recent' || q.status === 'all'
        ? q.status
        : q.status == null
          ? 'all'
          : null;
    if (!status) {
      return reply.code(400).send({ error: 'bad_query', message: 'invalid status filter' });
    }
    const rawLimit = q.limit == null ? 50 : Number(q.limit);
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'limit must be positive' });
    }
    const limit = Math.min(200, Math.floor(rawLimit));
    return { sessions: await sessionRuns.listSessionsForUser({ userId: user.id, status, limit }) };
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    return { session: await sessionRuns.getSessionForUser(id, user.id) };
  });

  app.get('/api/sessions/:id/profile-change-proposals', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    return { proposals: await agentProfiles.listSessionProposals(id, user.id) };
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/discard', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    return { proposal: await agentProfiles.discardProposal(user.id, id, proposalId) };
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/apply-lineage', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    return { proposal: await agentProfiles.applyProposalToLineage(user.id, id, proposalId) };
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/save-current-profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    const body = (req.body ?? {}) as { profileId?: unknown; name?: unknown };
    return await agentProfiles.saveProposalToCurrentProfile(user.id, id, proposalId, {
      ...(typeof body.profileId === 'string' ? { profileId: body.profileId } : {}),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
    });
  });

  app.post('/api/sessions/:id/profile-change-proposals/:proposalId/save-new-profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name : '';
    return await agentProfiles.saveProposalToNewProfile(user.id, id, proposalId, name);
  });

  // The durable session record (transcript + human-side overlay) for agents +
  // async humans. Channel-access gated like every other session sub-resource.
  app.get('/api/sessions/:id/record', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const record = await sessionRuns.getSessionRecord(id);
    // Own-session work-product record: annotate scope but DON'T filter — the
    // session owns these artifacts (private-vs-shared is a cross-session concern;
    // a session always sees its own files, including bare/private-scoped paths).
    record.artifacts = record.artifacts.map((artifact) => ({
      ...artifact,
      scope: classifyScope(artifact.path),
    }));
    return { record };
  });

  async function sessionChannelId(sessionId: string): Promise<string | null> {
    const res = await pool.query<{ channel_id: string }>('SELECT channel_id FROM sessions WHERE id = $1', [sessionId]);
    return res.rows[0]?.channel_id ?? null;
  }

  async function sessionAppContext(sessionId: string): Promise<{ workspaceId: string; channelId: string } | null> {
    const res = await pool.query<{ workspace_id: string; channel_id: string }>(
      'SELECT workspace_id, channel_id FROM sessions WHERE id = $1',
      [sessionId],
    );
    const row = res.rows[0];
    return row ? { workspaceId: row.workspace_id, channelId: row.channel_id } : null;
  }

  async function resolveInternalSessionRef(
    sessionRef: string,
  ): Promise<{ id: string; channelId: string } | null> {
    const res = await pool.query<{ id: string; channel_id: string }>(
      `SELECT id, channel_id
         FROM sessions
        WHERE id::text = $1 OR centaur_thread_key = $1
        LIMIT 1`,
      [sessionRef],
    );
    const row = res.rows[0];
    return row ? { id: row.id, channelId: row.channel_id } : null;
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

  app.post('/api/sessions/:id/apps', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: unknown; entry?: unknown; scope?: unknown };
    if (typeof body.name !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'name is required' });
    }
    const scope: AppScope = body.scope === 'workspace' ? 'workspace' : 'channel';
    const entry = typeof body.entry === 'string' && body.entry.trim() ? body.entry : 'index.html';
    const ctx = await sessionAppContext(id);
    if (!ctx) return reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
    const published = await appRegistry.publish({
      sessionId: id,
      workspaceId: ctx.workspaceId,
      channelId: ctx.channelId,
      userId: user.id,
      name: body.name,
      scope,
      entry,
    });
    return reply.send(published);
  });

  app.get('/api/apps', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return reply.send({ apps: await appRegistry.listForUser(user.id) });
  });

  app.post('/api/apps/:appId/launch', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { appId } = req.params as { appId: string };
    const body = (req.body ?? {}) as { version?: unknown };
    const version = body.version == null ? undefined : Number(body.version);
    if (version !== undefined && (!Number.isSafeInteger(version) || version <= 0)) {
      return reply.code(400).send({ error: 'bad_request', message: 'version must be a positive integer' });
    }
    return reply.send(await appRegistry.launch(appId, user.id, version));
  });

  // === Phase 3 unified Files routes ===
  {
    const { createGitSource } = await import('./git-source.js');
    const { resolveBacking } = await import('./file-resolver.js');
    const gitPrefix = normalizeFilesGitPrefix(process.env.GIT_PREFIX ?? 'repo/');
    const gitSource = createGitSource(process.env.GIT_REPO_ROOT);

    type UnifiedFileRow = {
      path: string;
      canonicalPath?: string;
      displayPath?: string;
      backing: 'git' | 'ledger';
      type: 'file' | 'dir';
      scope?: ArtifactScope;
      mime?: string;
      mediaKind?: string;
      isText?: boolean;
      sizeBytes?: number;
      seq?: number;
    };

    function normalizeFilesGitPrefix(value: string): string {
      const trimmed = value.trim();
      const prefix = trimmed.length > 0 ? trimmed : 'repo/';
      return prefix.endsWith('/') ? prefix : `${prefix}/`;
    }

    function normalizeFilesDir(value: unknown): string | null {
      if (value == null) return '';
      if (typeof value !== 'string') return null;
      const dir = value.trim();
      if (dir.includes('\0') || dir.includes('..') || dir.startsWith('/')) return null;
      return dir.replace(/\/+$/g, '');
    }

    function normalizeFilesPath(value: unknown): string | null {
      if (typeof value !== 'string') return null;
      const path = value.trim();
      if (!path || path.includes('\0') || path.includes('..') || path.startsWith('/')) return null;
      return path;
    }

    function gitRelDirForApiDir(dir: string): string | null {
      const prefixRoot = gitPrefix.replace(/\/+$/g, '');
      if (dir.length === 0) return '';
      if (dir === prefixRoot) return '';
      if (dir.startsWith(gitPrefix)) return dir.slice(gitPrefix.length).replace(/\/+$/g, '');
      return null;
    }

    function ledgerRowsForDir(
      scope: Array<{
        path: string;
        latestSeq: number;
        kind: string;
        detectedMime: string | null;
        mediaKind: string | null;
        isText: boolean | null;
        sizeBytes: number | null;
      }>,
      dir: string,
      ctx: { sessionId: string; channelId: string },
    ): UnifiedFileRow[] {
      const prefix = dir.length > 0 ? `${dir}/` : '';
      const rows = new Map<string, UnifiedFileRow>();
      for (const item of scope) {
        // === ACL scope enforcement (#4) ===
        const artifactScope = classifyScope(item.path);
        if (!userCanReadSessionArtifactPath(item.path, ctx.sessionId)) continue;
        if (item.kind === 'deleted') continue;
        if (resolveBacking(item.path, { gitPrefix }).backing !== 'ledger') continue;
        for (const alias of sessionArtifactPathAliases(item.path, ctx)) {
          if (!alias.startsWith(prefix)) continue;
          const rest = alias.slice(prefix.length);
          if (!rest) continue;
          const slash = rest.indexOf('/');
          const path = slash < 0 ? alias : `${prefix}${rest.slice(0, slash)}`;
          const type = slash < 0 ? 'file' : 'dir';
          const rowScope = artifactScope;
          const canonicalPath = type === 'file' ? item.path : undefined;
          const displayPath = type === 'file' ? displaySessionArtifactPath(item.path, ctx) : undefined;
          if (!rows.has(path) || type === 'dir') {
            rows.set(path, {
              path,
              canonicalPath,
              displayPath,
              backing: 'ledger',
              type,
              scope: rowScope,
              ...(type === 'file' && item.detectedMime != null ? { mime: item.detectedMime } : {}),
              ...(type === 'file' && item.mediaKind != null ? { mediaKind: item.mediaKind } : {}),
              ...(type === 'file' && item.isText != null ? { isText: item.isText } : {}),
              ...(type === 'file' && item.sizeBytes != null ? { sizeBytes: Number(item.sizeBytes) } : {}),
              ...(type === 'file' ? { seq: item.latestSeq } : {}),
            });
          }
        }
      }
      return [...rows.values()];
    }

    function bodyBuffer(body: unknown): Buffer {
      if (Buffer.isBuffer(body)) return body;
      if (body instanceof Uint8Array) return Buffer.from(body);
      return Buffer.alloc(0);
    }

    function unsafeGitPathError(err: unknown): boolean {
      return err instanceof Error && err.message === 'unsafe git path';
    }

    function isoDate(value: Date | string): string {
      return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    }

    async function ledgerHistory(sessionId: string, path: string) {
      const res = await pool.query<{
        seq: number;
        blob_sha: string | null;
        author: string;
        kind: string;
        status: string;
        created_at: Date | string;
      }>(
        `SELECT v.seq, v.blob_sha, v.author, v.kind, v.status, v.created_at
           FROM sessions s
           JOIN artifacts a ON a.workspace_id = s.workspace_id
           JOIN artifact_versions v ON v.artifact_id = a.id
          WHERE s.id = $1 AND a.path = $2
          ORDER BY v.seq DESC`,
        [sessionId, path],
      );
      return res.rows.map((row) => ({
        seq: row.seq,
        sha: row.blob_sha,
        author: row.author,
        date: isoDate(row.created_at),
        kind: row.kind,
        status: row.status,
      }));
    }

    await app.register(async (filesScope) => {
      filesScope.addContentTypeParser(
        '*',
        { parseAs: 'buffer', bodyLimit: config.maxUploadBytes },
        (_req, body, done) => done(null, body),
      );

      filesScope.get('/api/sessions/:id/files', async (req, reply) => {
        const user = await requireSessionAccess(req, reply);
        if (!user) return;
        const { id } = req.params as { id: string };
        const dir = normalizeFilesDir((req.query as { dir?: unknown }).dir);
        if (dir == null) {
          return reply.code(400).send({ error: 'bad_query', message: 'dir must be a safe relative path' });
        }

        const access = await sessionArtifactAccess(id, user.id);
        const channelId = access.channelId;
        const ledger = new ArtifactLedger(pool);
        const rows = ledgerRowsForDir(await ledger.sessionScope(id), dir, { sessionId: id, channelId });
        const gitRelDir = gitRelDirForApiDir(dir);
        if (gitRelDir != null && gitSource.isConfigured()) {
          try {
            const gitRows = await gitSource.listDir(gitRelDir);
            rows.push(...gitRows.map((row) => ({ ...row, path: `${gitPrefix}${row.path}`, backing: 'git' as const })));
          } catch (err) {
            if (unsafeGitPathError(err)) {
              return reply.code(400).send({ error: 'bad_query', message: 'dir must be a safe relative path' });
            }
            throw err;
          }
        }
        rows.sort((a, b) => a.path.localeCompare(b.path) || a.backing.localeCompare(b.backing));
        return reply.send({
          activePrefix: access.activePrefix,
          readableRoots: serializeArtifactRoots(access.readableRoots),
          writableRoots: serializeArtifactRoots(access.writableRoots),
          rows,
        });
      });

      filesScope.get('/api/sessions/:id/files/history', async (req, reply) => {
        const user = await requireSessionAccess(req, reply);
        if (!user) return;
        const { id } = req.params as { id: string };
        const path = normalizeFilesPath((req.query as { path?: unknown }).path);
        if (path == null) {
          return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
        }

        const resolved = resolveBacking(path, { gitPrefix });
        // === ACL scope enforcement (#4) ===
        const access = resolved.backing === 'ledger' ? await sessionArtifactAccess(id, user.id) : null;
        const channelId = access?.channelId ?? null;
        const ledgerPath = resolved.backing === 'ledger'
          ? canonicalizeRouteArtifactPath(reply, resolved.relPath, {
              sessionId: id,
              channelId: channelId!,
              readableChannelIds: access!.readableChannelIds,
            })
          : resolved.relPath;
        if (!ledgerPath) return;
        const scope = classifyScope(ledgerPath);
        if (resolved.backing === 'ledger' && !artifactPathInRoots(ledgerPath, access!.readableRoots)) {
          return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
        }
        if (resolved.backing === 'git') {
          if (!gitSource.isConfigured()) {
            return reply.code(404).send({ error: 'git_source_unconfigured', message: 'git source not configured' });
          }
          try {
            return reply.send({ backing: 'git', entries: await gitSource.history(resolved.relPath) });
          } catch (err) {
            if (unsafeGitPathError(err)) {
              return reply.code(400).send({ error: 'bad_query', message: 'path must be a safe relative path' });
            }
            throw err;
          }
        }

        return reply.send({
          backing: 'ledger',
          scope,
          canonicalPath: ledgerPath,
          displayPath: displaySessionArtifactPath(ledgerPath, { sessionId: id, channelId: channelId! }),
          entries: await ledgerHistory(id, ledgerPath),
        });
      });

      // Read content by backing: git files inline; ledger files via the
      // conflict-aware by-path serve (redirect so the last-normal +
      // X-Artifact-Conflicted semantics live in one place).
      filesScope.get('/api/sessions/:id/files/content', async (req, reply) => {
        const user = await requireSessionAccess(req, reply);
        if (!user) return;
        const { id } = req.params as { id: string };
        const path = normalizeFilesPath((req.query as { path?: unknown }).path);
        if (path == null) {
          return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
        }
        const resolved = resolveBacking(path, { gitPrefix });
        // === ACL scope enforcement (#4) ===
        let ledgerPath = resolved.relPath;
        let ledgerChannelId: string | null = null;
        let ledgerAccess: Awaited<ReturnType<typeof sessionArtifactAccess>> | null = null;
        if (resolved.backing === 'ledger') {
          ledgerAccess = await sessionArtifactAccess(id, user.id);
          const channelId = ledgerAccess.channelId;
          ledgerChannelId = channelId;
          const canonicalPath = canonicalizeRouteArtifactPath(reply, resolved.relPath, {
            sessionId: id,
            channelId,
            readableChannelIds: ledgerAccess.readableChannelIds,
          });
          if (!canonicalPath) return;
          ledgerPath = canonicalPath;
          if (!artifactPathInRoots(ledgerPath, ledgerAccess.readableRoots)) {
            return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
          }
        }
        if (resolved.backing === 'git') {
          if (!gitSource.isConfigured()) {
            return reply.code(404).send({ error: 'git_source_unconfigured', message: 'git source not configured' });
          }
          try {
            const file = await gitSource.readFile(resolved.relPath);
            if (!file) return reply.code(404).send({ error: 'not_found', message: 'file not found' });
            const classification = classifyMedia(file.bytes, { filename: resolved.relPath });
            reply.header('X-File-Backing', 'git');
            reply.header('X-Git-Blob-Sha', file.sha);
            reply.header('X-Canonical-Path', resolved.relPath);
            reply.header('X-Display-Path', path);
            reply.header('X-Size-Bytes', String(file.bytes.byteLength));
            for (const [name, value] of Object.entries(mediaHeaders(classification))) reply.header(name, value);
            reply.header('Content-Type', classification.isText ? `${classification.detectedMime}; charset=${classification.textEncoding ?? 'utf-8'}` : classification.detectedMime);
            return reply.send(file.bytes);
          } catch (err) {
            if (unsafeGitPathError(err)) {
              return reply.code(400).send({ error: 'bad_query', message: 'path must be a safe relative path' });
            }
            throw err;
          }
        }
        const ledger = new ArtifactLedger(pool);
        const res = await ledger.serveResolution(id, ledgerPath, {
          readableChannelIds: ledgerAccess?.readableChannelIds,
        });
        if (!res || res.servedSeq == null) {
          return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
        }
        const version = await ledger.resolveVersion(id, ledgerPath, { seq: res.servedSeq }, {
          readableChannelIds: ledgerAccess?.readableChannelIds,
        });
        if (!version) return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
        if (version.kind === 'deleted') {
          return reply.code(410).send({ error: 'artifact_deleted', message: 'artifact was deleted' });
        }
        if (!version.s3Key || !version.blobSha) {
          return reply.code(503).send({ error: 'blob_unavailable', message: 'artifact bytes are not durable in CAS' });
        }
        const bytes = await getObjectBytes(version.s3Key);
        const classification = {
          detectedMime: version.detectedMime ?? version.mime ?? 'application/octet-stream',
          mediaKind: version.mediaKind ?? 'binary',
          isText: version.isText ?? false,
          textEncoding: version.textEncoding ?? null,
          meta: {},
        } satisfies MediaClassification;
        reply.header('X-File-Backing', 'ledger');
        reply.header('X-Artifact-Seq', String(version.seq));
        reply.header('X-Artifact-Sha', version.blobSha);
        reply.header('X-Artifact-Conflicted', res.conflicted ? 'true' : 'false');
        if (res.conflictSeq != null) reply.header('X-Artifact-Conflict-Seq', String(res.conflictSeq));
        reply.header('X-Canonical-Path', ledgerPath);
        reply.header('X-Display-Path', displaySessionArtifactPath(ledgerPath, { sessionId: id, channelId: ledgerChannelId! }));
        reply.header('X-Size-Bytes', String(version.sizeBytes ?? bytes.byteLength));
        for (const [name, value] of Object.entries(mediaHeaders(classification))) reply.header(name, value);
        reply.header('Content-Type', classification.isText ? `${classification.detectedMime}; charset=${classification.textEncoding ?? 'utf-8'}` : classification.detectedMime);
        return reply.send(bytes);
      });

      filesScope.put('/api/sessions/:id/files', async (req, reply) => {
        const user = await requireSessionAccess(req, reply);
        if (!user) return;
        const { id } = req.params as { id: string };
        const path = normalizeFilesPath((req.query as { path?: unknown }).path);
        if (path == null) {
          return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
        }

        const resolved = resolveBacking(path, { gitPrefix });
        if (resolved.backing === 'git') {
          return reply.code(405).send({
            error: 'repo_read_only',
            message: 'repo files are read-only in-app; steer the agent to change code',
          });
        }

        const baseSeq = parseBaseSeq(firstHeader(req.headers['x-artifact-base-seq']));
        if (baseSeq === false) {
          return reply.code(400).send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
        }
        const access = await sessionArtifactAccess(id, user.id);
        const channelId = access.channelId;
        const canonicalPath = canonicalizeRouteArtifactPath(reply, resolved.relPath, {
          sessionId: id,
          channelId,
          readableChannelIds: access.readableChannelIds,
        });
        if (!canonicalPath) return;
        if (!artifactPathInRoots(canonicalPath, access.writableRoots)) {
          return reply.code(403).send({ error: 'artifact_read_only', message: 'artifact path is not writable' });
        }
        const body = bodyBuffer(req.body);
        const classification = classifyMedia(body, {
          declaredMime: normalizeMime(firstHeader(req.headers['content-type'])),
          filename: canonicalPath,
        });
        if (!classification.isText) {
          return reply.code(415).send({
            error: 'binary_not_editable',
            message: 'binary files cannot be edited as text',
            mediaKind: classification.mediaKind,
          });
        }
        const result = await writeBackArtifact({
          pool,
          storage: { uploadObject, getObjectBytes, headObject },
          channelId,
          sessionId: id,
          path: canonicalPath,
          bytes: body,
          mime: classification.detectedMime,
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
        return reply.send({ backing: 'ledger', seq: result.seq });
      });
    });
  }

  // === serve route ===
  app.get('/api/sessions/:id/artifacts/by-path', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string; at?: string };
    const rawPath = q.path;
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
    }
    const access = await sessionArtifactAccess(id, user.id);
    const channelId = access.channelId;
    const path = canonicalizeRouteArtifactPath(reply, rawPath, {
      sessionId: id,
      channelId,
      readableChannelIds: access.readableChannelIds,
    });
    if (!path) return;
    // === ACL scope enforcement (#4) ===
    const scope = classifyScope(path);
    if (!artifactPathInRoots(path, access.readableRoots)) {
      return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
    }
    const displayPath = displaySessionArtifactPath(path, { sessionId: id, channelId });
    const at = q.at ?? 'latest';
    // Conflict-aware serve (§8B #5): for the default `latest`, serve the newest
    // status='normal' version (never the conflict-marker bytes) and flag an
    // unresolved conflict in headers so the UI can show a banner. Explicit `at`
    // (a seq) is served verbatim for inspect/resolve flows.
    let ref: { seq: number } | { pointer: string };
    const ledger = new ArtifactLedger(pool);
    if (at === 'latest') {
      const res = await ledger.serveResolution(id, path, { readableChannelIds: access.readableChannelIds });
      if (!res || res.servedSeq == null) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      reply.header('X-Artifact-Seq', String(res.servedSeq));
      reply.header('X-Artifact-Conflicted', res.conflicted ? 'true' : 'false');
      if (res.conflictSeq != null) reply.header('X-Artifact-Conflict-Seq', String(res.conflictSeq));
      ref = { seq: res.servedSeq };
    } else {
      ref = /^\d+$/.test(at) ? { seq: Number(at) } : { pointer: at };
    }
    const plan = await sessionRuns.getLedgerServePlan(id, path, ref, {
      readableChannelIds: access.readableChannelIds,
    });
    const version = await ledger.resolveVersion(id, path, ref, {
      readableChannelIds: access.readableChannelIds,
    });
    // === ACL scope enforcement (#4) ===
    reply.header('X-Artifact-Scope', scope);
    reply.header('X-Artifact-Canonical-Path', path);
    reply.header('X-Artifact-Display-Path', displayPath);
    if (version) {
      if (version.blobSha != null) reply.header('X-Artifact-Sha', version.blobSha);
      reply.header('X-Size-Bytes', String(version.sizeBytes ?? 0));
      reply.header('X-Detected-Mime', version.detectedMime ?? version.mime ?? 'application/octet-stream');
      reply.header('X-Media-Kind', version.mediaKind ?? 'binary');
      reply.header('X-Is-Text', version.isText ? 'true' : 'false');
      if (version.textEncoding != null) reply.header('X-Text-Encoding', version.textEncoding);
    }
    return reply.redirect(plan.url, 302);
  });

  app.get('/api/sessions/:id/artifacts/preview', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string; at?: string; renderer?: string };
    const rawPath = q.path;
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
    }
    const access = await sessionArtifactAccess(id, user.id);
    const channelId = access.channelId;
    const sharedChannelId = rawPath.trim().replace(/\\/g, '/').match(/^shared\/channels\/([^/]+)\//)?.[1];
    if (sharedChannelId && sharedChannelId !== channelId && !access.readableChannelIds.includes(sharedChannelId)) {
      return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
    }
    const path = canonicalizeRouteArtifactPath(reply, rawPath, {
      sessionId: id,
      channelId,
      readableChannelIds: access.readableChannelIds,
    });
    if (!path) return;
    // === ACL scope enforcement (#4) ===
    const scope = classifyScope(path);
    if (!artifactPathInRoots(path, access.readableRoots)) {
      return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
    }
    const displayPath = displaySessionArtifactPath(path, { sessionId: id, channelId });
    const at = q.at ?? 'latest';
    let ref: { seq: number } | { pointer: string };
    const ledger = new ArtifactLedger(pool);
    if (at === 'latest') {
      const res = await ledger.serveResolution(id, path, { readableChannelIds: access.readableChannelIds });
      if (!res || res.servedSeq == null) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      reply.header('X-Artifact-Seq', String(res.servedSeq));
      reply.header('X-Artifact-Conflicted', res.conflicted ? 'true' : 'false');
      if (res.conflictSeq != null) reply.header('X-Artifact-Conflict-Seq', String(res.conflictSeq));
      ref = { seq: res.servedSeq };
    } else {
      ref = /^\d+$/.test(at) ? { seq: Number(at) } : { pointer: at };
    }
    const plan = await sessionRuns.getLedgerServePlan(id, path, ref, {
      readableChannelIds: access.readableChannelIds,
    });
    const version = await ledger.resolveVersion(id, path, ref, {
      readableChannelIds: access.readableChannelIds,
    });
    const bytes = await previewBytes(plan);
    const renderer = resolveArtifactPreviewRenderer(path, version?.mime ?? null, q.renderer);
    const filename = basename(path) || 'artifact';
    reply.header('X-Artifact-Scope', scope);
    reply.header('X-Artifact-Canonical-Path', path);
    reply.header('X-Artifact-Display-Path', displayPath);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Disposition', `inline; filename="${sanitizeFilename(filename)}"`);
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        // cdn.tailwindcss.com is loaded as a <script> (the JIT runtime that injects
        // styles), so it must be in script-src too — not just style-src — or the
        // CSP blocks it and previews render unstyled. Verified in a real browser.
        "script-src 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://esm.sh https://cdn.tailwindcss.com",
        "style-src 'unsafe-inline' https://cdn.tailwindcss.com",
        'img-src data: blob: https:',
        'font-src data: https:',
        'connect-src https:',
        "frame-ancestors 'self'",
      ].join('; '),
    );
    reply.header('Content-Type', 'text/html; charset=utf-8');
    if (renderer === 'react-jsx') {
      return reply.send(reactJsxPreviewDocument(bytes.toString('utf8'), filename));
    }
    return reply.send(bytes);
  });

  // C1 inbound-sync source: the gap-free, egress-pollable change-feed the Centaur
  // node daemon polls for advances on this session's hydrated paths. `since` is an
  // opaque cursor token "<xid>.<id>"; omit it to start from the beginning. See
  // migration 034 for the gap-free (xid, id)-below-xmin-horizon semantics.
  app.get('/api/sessions/:id/artifacts/changes', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { since?: string; limit?: string };

    let cursor: ChangeCursor = CHANGE_CURSOR_ZERO;
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

    const ledger = new ArtifactLedger(pool);
    const page = await ledger.changesSince(id, cursor, limit);
    const access = await sessionArtifactAccess(id, user.id);
    const channelId = access.channelId;
    // === ACL scope enforcement (#4) ===
    const rows = page.rows
      .map((row) => ({
        ...row,
        canonicalPath: row.path,
        displayPath: displaySessionArtifactPath(row.path, { sessionId: id, channelId }),
        scope: classifyScope(row.path),
      }))
      .filter((row) => artifactPathInRoots(row.path, access.readableRoots));
    return reply.send({
      activePrefix: access.activePrefix,
      readableRoots: serializeArtifactRoots(access.readableRoots),
      writableRoots: serializeArtifactRoots(access.writableRoots),
      rows,
      next_cursor: `${page.nextCursor.xid}.${page.nextCursor.id}`,
    });
  });

  // Conflict detail (A3): the both-sides payload for the resolution UI.
  app.get('/api/sessions/:id/artifacts/conflict', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const path = (req.query as { path?: string }).path;
    if (typeof path !== 'string' || path.length === 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'path is required' });
    }
    const access = await sessionArtifactAccess(id, user.id);
    const channelId = access.channelId;
    const canonicalPath = canonicalizeRouteArtifactPath(reply, path, {
      sessionId: id,
      channelId,
      readableChannelIds: access.readableChannelIds,
    });
    if (!canonicalPath) return;
    // === ACL scope enforcement (#4) ===
    if (!artifactPathInRoots(canonicalPath, access.readableRoots)) {
      return reply.code(404).send({ error: 'no_conflict', message: 'no unresolved conflict at path' });
    }
    const detail = await loadConflictDetail(pool, { getObjectBytes }, id, canonicalPath, {
      readableChannelIds: access.readableChannelIds,
    });
    if (!detail) {
      return reply.code(404).send({ error: 'no_conflict', message: 'no unresolved conflict at path' });
    }
    return reply.send({
      ...detail,
      canonicalPath: detail.path,
      displayPath: displaySessionArtifactPath(detail.path, { sessionId: id, channelId }),
    });
  });

  // Resolve a conflict (A3): a write-back against the conflict seq advances
  // `latest` to a normal version (jj-style resolution, never a blind overwrite).
  // Body bytes = the resolved content; or { "delete": true } to stay-deleted.
  app.register(async (resolveScope) => {
    resolveScope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: config.maxUploadBytes },
      (_req, body, done) => done(null, body),
    );
    resolveScope.post('/api/sessions/:id/artifacts/:artifactId/resolve', async (req, reply) => {
      const user = await requireSessionAccess(req, reply);
      if (!user) return;
      const { id, artifactId } = req.params as { id: string; artifactId: string };
      const ledger = new ArtifactLedger(pool);
      const art = await ledger.artifactById(artifactId);
      if (!art) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      const access = await sessionArtifactAccess(id, user.id);
      if (art.workspaceId !== access.workspaceId || !artifactPathInRoots(art.path, access.writableRoots)) {
        return reply.code(404).send({ error: 'artifact_not_found', message: 'artifact not found' });
      }
      const conflict = await ledger.getConflict(id, art.path, { readableChannelIds: access.readableChannelIds });
      if (!conflict) {
        return reply.code(409).send({ error: 'no_conflict', message: 'artifact has no unresolved conflict' });
      }
      const stayDeleted = firstHeader(req.headers['x-artifact-delete']) === 'true';
      const result = stayDeleted
        ? await writeBackDelete({
            pool,
            channelId: access.channelId,
            sessionId: id,
            path: art.path,
            author: `human:${user.id}`,
            baseSeq: conflict.conflictSeq,
          })
        : await writeBackArtifact({
            pool,
            storage: { uploadObject, getObjectBytes, headObject },
            channelId: access.channelId,
            sessionId: id,
            path: art.path,
            bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
            mime: normalizeMime(firstHeader(req.headers['content-type'])),
            author: `human:${user.id}`,
            baseSeq: conflict.conflictSeq,
          });
      if (!result.ok) {
        return reply.code(409).send({ error: result.reason });
      }
      return reply.send({ seq: result.seq, status: result.status });
    });
  });

  // Hydration scope (A4): the artifact paths this session subscribes + latest seq
  // — the seed for the Centaur node's hydration manifest + subscription set.
  app.get('/api/sessions/:id/hydration-scope', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const access = await sessionArtifactAccess(id, user.id);
    const channelId = access.channelId;
    const ledger = new ArtifactLedger(pool);
    const paths = await ledger.sessionScope(id);
    // === ACL scope enforcement (#4) ===
    const scopedPaths = paths
      .map((path) => ({
        ...path,
        canonicalPath: path.path,
        displayPath: displaySessionArtifactPath(path.path, { sessionId: id, channelId }),
        scope: classifyScope(path.path),
      }))
      .filter((path) => artifactPathInRoots(path.path, access.readableRoots));
    return reply.send({
      sessionId: id,
      scope: 'session',
      activePrefix: access.activePrefix,
      readableRoots: serializeArtifactRoots(access.readableRoots),
      writableRoots: serializeArtifactRoots(access.writableRoots),
      paths: scopedPaths,
    });
  });

  // === /atrium chat projection ===
  app.get('/api/sessions/:id/atrium/chat', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { channel?: unknown; thread?: unknown };
    const channelId = typeof q.channel === 'string' ? q.channel.trim() : '';
    if (channelId.length === 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'channel is required' });
    }
    const session = await pool.query<{ channel_id: string }>(
      'SELECT channel_id FROM sessions WHERE id = $1',
      [id],
    );
    if (session.rows[0]?.channel_id !== channelId) {
      return reply.code(404).send({ error: 'channel_not_found', message: 'channel not found' });
    }

    const rawThread = q.thread;
    let events: WireEvent[] = [];
    let title = channelId;
    if (rawThread == null || rawThread === '') {
      let beforeId: number | undefined;
      for (let pageCount = 0; pageCount < 5; pageCount++) {
        const page = await listChannelMessages(pool, {
          channelId,
          limit: 200,
          ...(beforeId === undefined ? {} : { beforeId }),
        });
        events = [...page.events, ...events];
        if (!page.hasMore || page.events.length === 0) break;
        beforeId = page.events[0]!.id;
      }
    } else if (typeof rawThread === 'string') {
      const threadRootEventId = Number(rawThread.trim());
      if (!Number.isSafeInteger(threadRootEventId) || threadRootEventId <= 0) {
        return reply
          .code(400)
          .send({ error: 'bad_query', message: 'thread must be a positive event id' });
      }
      const root = await pool.query<{ channel_id: string | null }>(
        `SELECT channel_id
         FROM events
         WHERE id = $1 AND type IN ('message.posted', 'session.spawned')`,
        [threadRootEventId],
      );
      if (root.rows[0]?.channel_id !== channelId) {
        return reply.code(404).send({ error: 'thread_not_found', message: 'thread not found' });
      }
      events = (await listThreadMessages(pool, { rootEventId: threadRootEventId })).events;
      title = `${channelId}/${threadRootEventId}`;
    } else {
      return reply
        .code(400)
        .send({ error: 'bad_query', message: 'thread must be a positive event id' });
    }

    const messages = events.filter(
      (event) =>
        event.type === 'message.posted' &&
        event.channelId === channelId &&
        event.payload.deleted !== true,
    );
    const lines = [`# ${title}`, ''];
    for (const event of messages) {
      const author = event.author?.displayName ?? event.author?.handle ?? event.actorId ?? 'unknown';
      const tag = event.payload.edited === true ? ' (edited)' : '';
      const text = typeof event.payload.text === 'string' ? event.payload.text : '';
      lines.push(`**${author}**${tag}: ${text}`);
    }
    return reply.send({ markdown: `${lines.join('\n')}\n`, messageCount: messages.length });
  });

  // === /atrium session projection + change-feed (#72 P3) ===
  type AtriumSessionProjectionModule = typeof import('./atrium-session-projection.js');
  type AtriumSessionRecords = Awaited<
    ReturnType<AtriumSessionProjectionModule['loadSessionRecords']>
  >;
  type AtriumMarkdownRenderer = (
    projection: AtriumSessionProjectionModule,
    records: AtriumSessionRecords,
    sessionId: string,
  ) => string | Promise<string>;

  async function sendAtriumMarkdown(
    req: FastifyRequest,
    reply: FastifyReply,
    tier: 'lean' | 'full',
    render: AtriumMarkdownRenderer,
    requireFullView = false,
  ) {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    if (requireFullView && !(await canViewFull(user.id))) return fullViewForbidden(reply);
    const { id } = req.params as { id: string };
    const projection = await import('./atrium-session-projection.js');
    const records = await projection.loadSessionRecords(pool, id, tier);
    const markdown = await render(projection, records, id);
    return reply.type('text/markdown; charset=utf-8').send(markdown);
  }

  app.get('/api/sessions/:id/atrium/transcript', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'lean', (projection, records) =>
      projection.renderTranscriptMarkdown(records),
    ),
  );

  app.get('/api/sessions/:id/atrium/full', async (req, reply) =>
    sendAtriumMarkdown(
      req,
      reply,
      'full',
      (projection, records) => projection.renderFullMarkdown(records),
      true,
    ),
  );

  app.get('/api/sessions/:id/atrium/summary', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'full', async (projection, records, sessionId) =>
      projection.renderSummaryMarkdown(records, await projection.buildSessionMeta(pool, sessionId)),
    ),
  );

  app.get('/api/sessions/:id/atrium/meta', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const { buildSessionMeta } = await import('./atrium-session-projection.js');
    return reply.type('application/json').send(await buildSessionMeta(pool, id));
  });

  app.get('/api/sessions/:id/atrium/changes-doc', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'full', (projection, records) =>
      projection.renderChangesMarkdown(records),
    ),
  );

  app.get('/api/sessions/:id/atrium/tools', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'full', (projection, records) =>
      projection.renderToolsMarkdown(records),
    ),
  );

  app.get('/api/sessions/:id/atrium/artifacts', async (req, reply) =>
    sendAtriumMarkdown(req, reply, 'lean', (projection, records) =>
      projection.renderArtifactsMarkdown(records),
    ),
  );

  app.get('/api/sessions/:id/atrium/events', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    if (!(await canViewFull(user.id))) return fullViewForbidden(reply);
    const { id } = req.params as { id: string };
    const { loadSessionRecords, renderEventsJsonl } = await import(
      './atrium-session-projection.js'
    );
    const records = await loadSessionRecords(pool, id, 'full');
    return reply.type('application/jsonl; charset=utf-8').send(renderEventsJsonl(records));
  });

  app.post('/api/sessions/:id/atrium/reproject', async (req, reply) => {
    const user = await requireSessionAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const { projectAndEmitChange } = await import('./session-record-changefeed.js');
    const projected = await projectAndEmitChange(pool, id);
    return reply.send({ projected });
  });

  app.get('/api/atrium/changes', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
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

    const page = await changefeed.sessionRecordChangesSince(pool, {
      userId: user.id,
      cursor,
      limit,
    });
    return reply.send({
      rows: page.rows,
      next_cursor: `${page.nextCursor.xid}.${page.nextCursor.id}`,
    });
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
  async function resolveViewer(
    viewerId: string,
    reply: FastifyReply,
  ): Promise<UserRef | null> {
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
        return reply
          .type('text/markdown; charset=utf-8')
          .send(projection.renderTranscriptMarkdown(records));
      }
      case 'full': {
        if (!(await canViewFull(viewerUser.id))) return fullViewForbidden(reply);
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        return reply
          .type('text/markdown; charset=utf-8')
          .send(projection.renderFullMarkdown(records));
      }
      case 'summary': {
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        const meta = await projection.buildSessionMeta(pool, targetId);
        return reply
          .type('text/markdown; charset=utf-8')
          .send(projection.renderSummaryMarkdown(records, meta));
      }
      case 'meta':
        return reply.type('application/json').send(await projection.buildSessionMeta(pool, targetId));
      case 'tools': {
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        return reply
          .type('text/markdown; charset=utf-8')
          .send(projection.renderToolsMarkdown(records));
      }
      case 'artifacts': {
        const records = await projection.loadSessionRecords(pool, targetId, 'lean');
        return reply
          .type('text/markdown; charset=utf-8')
          .send(projection.renderArtifactsMarkdown(records));
      }
      case 'changes-doc': {
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        return reply
          .type('text/markdown; charset=utf-8')
          .send(projection.renderChangesMarkdown(records));
      }
      case 'events': {
        if (!(await canViewFull(viewerUser.id))) return fullViewForbidden(reply);
        const records = await projection.loadSessionRecords(pool, targetId, 'full');
        return reply
          .type('application/jsonl; charset=utf-8')
          .send(projection.renderEventsJsonl(records));
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
    capture.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: config.maxUploadBytes },
      (_req, body, done) => done(null, body),
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
        return reply.code(400).send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
      }
      const isDelete = firstHeader(req.headers['x-artifact-delete']) === 'true';
      const author = `node:${id}`;
      const result = isDelete
        ? await writeBackDelete({ pool, channelId: session.channelId, sessionId: session.id, path: canonicalPath, author, ...(baseSeq == null ? {} : { baseSeq }) })
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
        return reply.code(400).send({ error: 'bad_request', message: 'X-Artifact-Base-Seq must be a positive integer' });
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
    ht.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: config.maxUploadBytes },
      (_req, body, done) => done(null, body),
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
    const bundle = await loadHarnessStateBundle(pool, id, harness);
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
    const sess = await pool.query<{ id: string }>(`SELECT id FROM sessions WHERE id = $1`, [id]);
    if (!sess.rows[0]) return reply.code(404).send({ error: 'session_not_found' });
    try {
      const { size, sha256 } = await storeHarnessStateBundle(
        pool,
        { uploadObject },
        id,
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

  app.put('/api/internal/sessions/:id/provider-credential-refresh', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;
    const { id } = req.params as { id: string };
    const harness = (req.query as { harness?: string }).harness ?? '';
    if (!isHarness(harness)) {
      return reply.code(400).send({ error: 'bad_query', message: 'harness must be claude|codex' });
    }
    const session = await pool.query<{ spawned_by: string }>(
      'SELECT spawned_by FROM sessions WHERE id = $1',
      [id],
    );
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
        blobSha: file.kind === 'deleted' ? null : blobSha as string,
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
  async function requireSessionAccess(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<UserRef | null> {
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
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'questionId and answers are required' });
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
      body: { sessionId: id, suggestionId, action, ...(text !== undefined ? { text } : {}), ...(note !== undefined ? { note } : {}) },
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

  // -------------------------------------------------------------------------
  // Push notifications (Expo)
  // -------------------------------------------------------------------------

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

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));

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
          const ids = msg.channelIds
            .filter((v): v is string => typeof v === 'string')
            .slice(0, 500);
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
