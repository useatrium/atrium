import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import { config } from '../src/config.js';
import { createChannel, getOrCreateDm } from '../src/events.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import { addWorkspaceMember } from '../src/membership.js';
import { githubPatSecretForeignId, IronControlAdminClient } from '../src/iron-control.js';
import { SeededPrng } from './chaosHarness.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

interface RecordedRequest {
  method: string;
  path: string;
  body: any;
  query: URLSearchParams;
}

class FakeCentaur {
  private server: Server;
  private frames: any[] = [];
  private readonly idempotency = new Map<string, { payload: string; response: object }>();
  private readonly threadGenerations = new Map<string, number>();
  private pauseExecuteGate: { promise: Promise<void>; release: () => void } | null = null;
  readonly requests: RecordedRequest[] = [];
  readonly answers: RecordedRequest[] = [];
  readonly acceptedExecutions: string[] = [];
  readonly acceptedMessages: string[] = [];
  readonly streamAfterIds: number[] = [];
  staleMessages = new Set<string>();
  streamHangOpen = false;
  streamResetBeyondHistory = false;
  streamWriteCommentBeforeSecondFrame = false;
  streamClosedCount = 0;
  private answerNotPendingCount = 0;
  url = '';

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<void> {
    const fixture = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'centaur-client', 'test', 'fixtures', 'A_pong.json'),
      'utf8',
    );
    this.frames = JSON.parse(fixture);
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('fake server did not bind tcp');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
        else resolve();
      });
    });
  }

  clearFrames(): void {
    this.frames = [];
  }

  setFrames(frames: any[]): void {
    this.frames = frames;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJson(req);
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, body, query: url.searchParams });

    const answerMatch = /^\/api\/session\/([^/]+)\/executions\/([^/]+)\/answer$/.exec(url.pathname);
    if (req.method === 'POST' && answerMatch) {
      const threadKey = decodeURIComponent(answerMatch[1]!);
      const executionId = decodeURIComponent(answerMatch[2]!);
      this.answers.push({
        method: 'POST',
        path: `/api/session/${threadKey}/executions/${executionId}/answer`,
        body,
        query: url.searchParams,
      });
      if (this.answerNotPendingCount > 0) {
        this.answerNotPendingCount -= 1;
        return sendJson(res, { code: 'QUESTION_NOT_PENDING' }, 409);
      }
      return sendJson(res, { ok: true, execution_id: executionId, thread_key: threadKey, status: 'answered' });
    }

    const sessionMatch = /^\/api\/session\/([^/]+)(?:\/(messages|execute|events|cancel))?$/.exec(url.pathname);
    if (sessionMatch) {
      const threadKey = decodeURIComponent(sessionMatch[1]!);
      const action = sessionMatch[2] ?? '';
      if (req.method === 'POST' && action === '') {
        const metadata = isRecord(body.metadata) ? body.metadata : {};
        const spawnId = typeof metadata.spawn_id === 'string' ? metadata.spawn_id : undefined;
        const legacyBody = {
          thread_key: threadKey,
          harness: body.harness_type,
          spawn_id: spawnId,
          metadata,
          ...(Array.isArray(body.repos) ? { repos: body.repos } : {}),
        };
        this.recordLegacy('POST', '/agent/spawn', legacyBody, url.searchParams);
        const replay = this.replayIdempotent(res, 'spawn', threadKey, spawnId, legacyBody);
        if (replay) return;
        const generation = (this.threadGenerations.get(threadKey) ?? 0) + 1;
        this.threadGenerations.set(threadKey, generation);
        const response = { thread_key: threadKey, assignment_generation: generation };
        this.rememberIdempotent('spawn', threadKey, spawnId, legacyBody, response);
        return sendJson(res, response);
      }
      if (req.method === 'POST' && action === 'messages') {
        const message = Array.isArray(body.messages) && isRecord(body.messages[0]) ? body.messages[0] : {};
        const metadata = isRecord(message.metadata) ? message.metadata : {};
        const messageId = typeof message.client_message_id === 'string' ? message.client_message_id : undefined;
        const legacyBody = {
          thread_key: threadKey,
          assignment_generation: this.threadGenerations.get(threadKey) ?? 1,
          role: message.role,
          parts: message.parts,
          metadata,
          ...(typeof metadata.user_id === 'string' ? { user_id: metadata.user_id } : {}),
          ...(messageId ? { message_id: messageId } : {}),
        };
        this.recordLegacy('POST', '/agent/message', legacyBody, url.searchParams);
        if (this.staleMessages.delete(threadKey)) {
          return sendJson(res, { code: 'ASSIGNMENT_GENERATION_STALE' }, 409);
        }
        if (typeof metadata.question_id === 'string') {
          this.answers.push({
            method: 'POST',
            path: `/agent/executions/${metadata.execution_id || 'exe_fake'}/answer`,
            body: {
              question_id: metadata.question_id,
              answers: metadata.answers,
            },
            query: url.searchParams,
          });
          if (this.answerNotPendingCount > 0) {
            this.answerNotPendingCount -= 1;
            return sendJson(res, { code: 'QUESTION_NOT_PENDING' }, 409);
          }
        }
        const replay = this.replayIdempotent(res, 'message', threadKey, messageId, legacyBody);
        if (replay) return;
        this.rememberIdempotent('message', threadKey, messageId, legacyBody, {});
        if (messageId) this.acceptedMessages.push(messageId);
        return sendJson(res, {});
      }
      if (req.method === 'POST' && action === 'execute') {
        const metadata = isRecord(body.metadata) ? body.metadata : {};
        const executeId = typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined;
        const legacyBody = {
          thread_key: threadKey,
          assignment_generation: this.threadGenerations.get(threadKey) ?? 1,
          harness: metadata.harness,
          delivery: { platform: 'dev' },
          ...(isRecord(body.environment) ? { environment: body.environment } : {}),
          ...(executeId ? { execute_id: executeId } : {}),
        };
        this.recordLegacy('POST', '/agent/execute', legacyBody, url.searchParams);
        const replay = this.replayIdempotent(res, 'execute', threadKey, executeId, legacyBody);
        if (replay) return;
        await this.waitForExecuteGate();
        const executionId = `exe_fake_${this.acceptedExecutions.length + 1}`;
        const response = { execution_id: executionId };
        this.acceptedExecutions.push(executionId);
        this.rememberIdempotent('execute', threadKey, executeId, legacyBody, response);
        return sendJson(res, response);
      }
      if (req.method === 'POST' && action === 'cancel') {
        return sendJson(res, { ok: true, cancelled: true, execution_id: 'exe_fake' });
      }
      if (req.method === 'GET' && action === 'events') {
        this.recordLegacy('GET', `/agent/threads/${threadKey}/events`, {}, url.searchParams);
        return this.writeEventStream(res, url);
      }
    }

    if (req.method === 'POST' && url.pathname === '/agent/spawn') {
      const replay = this.replayIdempotent(res, 'spawn', body.thread_key, body.spawn_id, body);
      if (replay) return;
      const generation = (this.threadGenerations.get(body.thread_key) ?? 0) + 1;
      this.threadGenerations.set(body.thread_key, generation);
      const response = { thread_key: body.thread_key, assignment_generation: generation };
      this.rememberIdempotent('spawn', body.thread_key, body.spawn_id, body, response);
      return sendJson(res, response);
    }
    if (req.method === 'POST' && url.pathname === '/agent/message') {
      if (this.staleMessages.delete(body.thread_key)) {
        return sendJson(res, { code: 'ASSIGNMENT_GENERATION_STALE' }, 409);
      }
      const current = this.threadGenerations.get(body.thread_key);
      if (current != null && body.assignment_generation < current) {
        return sendJson(res, { code: 'ASSIGNMENT_GENERATION_STALE' }, 409);
      }
      const replay = this.replayIdempotent(res, 'message', body.thread_key, body.message_id, body);
      if (replay) return;
      this.rememberIdempotent('message', body.thread_key, body.message_id, body, {});
      if (body.message_id) this.acceptedMessages.push(body.message_id);
      return sendJson(res, {});
    }
    if (req.method === 'POST' && url.pathname === '/agent/execute') {
      const replay = this.replayIdempotent(res, 'execute', body.thread_key, body.execute_id, body);
      if (replay) return;
      await this.waitForExecuteGate();
      const executionId = `exe_fake_${this.acceptedExecutions.length + 1}`;
      const response = { execution_id: executionId };
      this.acceptedExecutions.push(executionId);
      this.rememberIdempotent('execute', body.thread_key, body.execute_id, body, response);
      return sendJson(res, response);
    }
    if (req.method === 'POST' && /^\/agent\/executions\/[^/]+\/answer$/.test(url.pathname)) {
      this.answers.push({ method: req.method ?? 'POST', path: url.pathname, body, query: url.searchParams });
      if (this.answerNotPendingCount > 0) {
        this.answerNotPendingCount -= 1;
        return sendJson(res, { code: 'QUESTION_NOT_PENDING' }, 409);
      }
      return sendJson(res, {});
    }
    if (req.method === 'POST' && url.pathname.endsWith('/release')) {
      return sendJson(res, {});
    }
    if (req.method === 'GET' && /\/agent\/threads\/[^/]+\/events/.test(url.pathname)) {
      return this.writeEventStream(res, url);
    }

    res.writeHead(404);
    res.end('not found');
  }

  setThreadGeneration(threadKey: string, generation: number): void {
    this.threadGenerations.set(threadKey, generation);
  }

  seedAcceptedExecute(threadKey: string, executeId: string, body: object, response: object): void {
    this.acceptedExecutions.push((response as { execution_id: string }).execution_id);
    this.rememberIdempotent('execute', threadKey, executeId, body, response);
  }

  seedAcceptedMessage(threadKey: string, messageId: string, body: object): void {
    this.acceptedMessages.push(messageId);
    this.rememberIdempotent('message', threadKey, messageId, body, {});
  }

  rejectNextAnswerQuestionNotPending(): void {
    this.answerNotPendingCount += 1;
  }

  pauseNextExecute(): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pauseExecuteGate = { promise, release };
  }

  releasePausedExecute(): void {
    this.pauseExecuteGate?.release();
  }

  private async waitForExecuteGate(): Promise<void> {
    const gate = this.pauseExecuteGate;
    if (!gate) return;
    await gate.promise;
    if (this.pauseExecuteGate === gate) this.pauseExecuteGate = null;
  }

  private recordLegacy(method: string, path: string, body: any, query: URLSearchParams): void {
    this.requests.push({ method, path, body, query });
  }

  private writeEventStream(res: ServerResponse, url: URL): void {
    const after = Number(url.searchParams.get('after_event_id') ?? 0);
    this.streamAfterIds.push(after);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const maxEventId = Math.max(0, ...this.frames.map((f) => Number(f.event_id) || 0));
    const effectiveAfter = this.streamResetBeyondHistory && after > maxEventId ? 0 : after;
    let index = 0;
    res.on('close', () => {
      this.streamClosedCount += 1;
    });
    for (const frame of this.frames.filter((f) => f.event_id > effectiveAfter)) {
      if (this.streamWriteCommentBeforeSecondFrame && index === 1) {
        res.write(': keep-alive\n\n');
      }
      res.write(`id: ${frame.event_id}\n`);
      res.write(`event: ${frame.event}\n`);
      res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
      index += 1;
    }
    if (this.streamHangOpen) return;
    res.end();
  }

  private replayIdempotent(
    res: ServerResponse,
    kind: string,
    threadKey: string,
    key: string | undefined,
    body: object,
  ): boolean {
    if (!key) return false;
    const existing = this.idempotency.get(`${kind}:${threadKey}:${key}`);
    if (!existing) return false;
    if (existing.payload !== JSON.stringify(body)) {
      sendJson(res, { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' }, 409);
      return true;
    }
    sendJson(res, existing.response);
    return true;
  }

  private rememberIdempotent(
    kind: string,
    threadKey: string,
    key: string | undefined,
    body: object,
    response: object,
  ): void {
    if (!key) return;
    this.idempotency.set(`${kind}:${threadKey}:${key}`, {
      payload: JSON.stringify(body),
      response,
    });
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

let pool: pg.Pool;
let fx: Fixture;
let fake: FakeCentaur;
const originalGitHubAppConfig = {
  appId: config.githubAppId,
  privateKey: config.githubAppPrivateKey,
  privateKeyId: config.githubAppPrivateKeyId,
};

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
  fake = new FakeCentaur();
  await fake.start();
});

afterEach(async () => {
  await fake?.stop();
  vi.unstubAllGlobals();
  config.githubAppId = originalGitHubAppConfig.appId;
  config.githubAppPrivateKey = originalGitHubAppConfig.privateKey;
  config.githubAppPrivateKeyId = originalGitHubAppConfig.privateKeyId;
});

function fakeSocket(): HubSocket {
  return {
    readyState: 1,
    send() {},
  };
}

async function loginUser(
  app: Awaited<ReturnType<typeof buildApp>>,
  handle: string,
  displayName: string,
): Promise<{ cookie: string; userId: string }> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  const userId = login.json().user.id;
  await addWorkspaceMember(pool, fx.workspaceId, userId);
  return { cookie: login.headers['set-cookie'] as string, userId };
}

async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const { cookie } = await loginUser(app, 'alice', 'Alice');
  await connectCodex(app, cookie);
  return cookie;
}

async function connectClaude(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  token = 'test-claude-oauth-token',
): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/me/provider-credentials/claude-code',
    headers: { cookie },
    payload: { token },
  });
  expect(res.statusCode).toBe(200);
}

const TEST_CODEX_AUTH_JSON = JSON.stringify({
  OPENAI_API_KEY: null,
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'test-codex-access-token',
    account_id: '00000000-0000-0000-0000-000000000000',
  },
});

async function connectCodex(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  authJson = TEST_CODEX_AUTH_JSON,
): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/me/provider-credentials/codex',
    headers: { cookie },
    payload: { authJson },
  });
  expect(res.statusCode).toBe(200);
}

async function connectGitHubMetadata(
  workspaceId: string,
  userId: string,
  tokenKind = 'pat',
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO user_connections
       (workspace_id, user_id, provider, status, token_kind, account_login, metadata)
     VALUES ($1, $2, 'github', 'connected', $3, 'octo-user', $4::jsonb)
     ON CONFLICT (workspace_id, user_id, provider) DO UPDATE
     SET status = EXCLUDED.status,
         token_kind = EXCLUDED.token_kind,
         metadata = EXCLUDED.metadata,
         account_login = EXCLUDED.account_login,
         updated_at = now()`,
    [workspaceId, userId, tokenKind, JSON.stringify(metadata)],
  );
}

async function insertRunningSession(driverId = fx.userId): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO sessions (
       workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
       driver_id, current_execution_id, assignment_generation
     )
     VALUES ($1, $2, $3, 'claude-code', 'seat test', 'running', $4, $5, 'exe_fake', 1)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, `thread-${randomUUID()}`, fx.userId, driverId],
  );
  return inserted.rows[0]!.id;
}

async function insertSessionRow(args: {
  channelId?: string;
  title: string;
  status: 'spawning' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  spawnedBy?: string;
  currentExecutionId?: string | null;
  assignmentGeneration?: number | null;
  createdAt?: string;
  completedAt?: string | null;
  costUsd?: number;
}): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO sessions (
       workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
       driver_id, current_execution_id, assignment_generation, created_at, completed_at, cost_usd
     )
     VALUES ($1, $2, $3, 'claude-code', $4, $5, $6, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      fx.workspaceId,
      args.channelId ?? fx.channelId,
      `thread-${randomUUID()}`,
      args.title,
      args.status,
      args.spawnedBy ?? fx.userId,
      args.currentExecutionId ?? 'exe_fake',
      args.assignmentGeneration === undefined ? 1 : args.assignmentGeneration,
      args.createdAt ?? new Date().toISOString(),
      args.completedAt ?? null,
      args.costUsd ?? 0,
    ],
  );
  return inserted.rows[0]!.id;
}

function questionRequestedFrame(eventId = 1) {
  return {
    event: 'question_requested',
    event_id: eventId,
    data: {
      type: 'question_requested',
      question_id: 'q-main',
      turn_id: 'turn-1',
      questions: [
        {
          id: 'choice',
          header: 'Decision',
          question: 'Which deployment path should I take?',
          multiSelect: true,
          options: [
            {
              label: 'Fast',
              description: 'Ship the smallest change',
              preview: 'FAST PATH',
              previewFormat: 'markdown',
            },
            {
              label: 'Careful',
              description: 'Run the full suite first',
              preview: '<div>Careful path</div>',
              previewFormat: 'html',
            },
          ],
        },
      ],
    },
  };
}

function questionResolvedFrame(reason: 'answered' | 'cancelled' | 'empty', eventId = 2) {
  return {
    event: 'question_resolved',
    event_id: eventId,
    data: { type: 'question_resolved', question_id: 'q-main', reason },
  };
}

async function setPendingQuestion(id: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET pending_question = $1 WHERE id = $2`,
    [
      JSON.stringify({
        questionId: 'q-main',
        turnId: 'turn-1',
        eventId: 1,
        questions: questionRequestedFrame().data.questions,
      }),
      id,
    ],
  );
}

async function mirrorArtifactFrame(
  sessionId: string,
  args: {
    eventId: number;
    artifactId: string;
    path: string;
    mime: string;
    ref: string | null;
    sizeBytes?: number;
    executionId?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO session_events (session_id, centaur_event_id, event_kind, frame)
     VALUES ($1, $2, 'artifact.captured', $3)`,
    [
      sessionId,
      args.eventId,
      JSON.stringify({
        event: 'artifact.captured',
        event_id: args.eventId,
        data: {
          type: 'artifact.captured',
          artifact_id: args.artifactId,
          ...(args.executionId ? { execution_id: args.executionId } : {}),
          path: args.path,
          kind: 'created',
          mime: args.mime,
          size_bytes: args.sizeBytes ?? 1024,
          sha256: `${args.artifactId}-sha`,
          ref: args.ref,
        },
      }),
    ],
  );
}

async function commitDurableArtifact(args: {
  sessionId: string;
  path: string;
  body: Buffer | string;
  mime?: string;
}): Promise<{ s3Key: string; sha: string }> {
  const body = Buffer.isBuffer(args.body) ? args.body : Buffer.from(args.body);
  const sha = createHash('sha256').update(body).digest('hex');
  const s3Key = casBlobKey(sha);
  await pool.query(
    `INSERT INTO cas_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sha256) DO UPDATE
           SET s3_key = COALESCE(cas_blobs.s3_key, EXCLUDED.s3_key)`,
    [sha, s3Key, body.byteLength, args.mime ?? 'application/octet-stream'],
  );
  const session = await pool.query<{ channel_id: string }>('SELECT channel_id FROM sessions WHERE id = $1', [
    args.sessionId,
  ]);
  await new ArtifactLedger(pool).commitVersion({
    sessionId: args.sessionId,
    channelId: session.rows[0]!.channel_id,
    path: args.path,
    blobSha: sha,
    sizeBytes: body.byteLength,
    mime: args.mime ?? 'application/octet-stream',
    author: `agent:${args.sessionId}`,
    kind: 'created',
  });
  return { s3Key, sha };
}

/** In-memory S3 stand-in for artifact serve. Mints a recognizable presigned URL. */
function fakeArtifactStorage() {
  const presignCalls: { key: string; filename: string; inline: boolean }[] = [];
  return {
    presignCalls,
    storage: {
      presignGet: async (key: string, filename: string, inline: boolean) => {
        presignCalls.push({ key, filename, inline });
        return `https://storage.local/get/${encodeURIComponent(key)}?inline=${inline ? 1 : 0}`;
      },
    },
  };
}

async function registerToken(userId: string, token: string): Promise<void> {
  await pool.query(
    `INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, $2, 'ios')`,
    [token, userId],
  );
}

function okPushFetch() {
  return vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const sent = JSON.parse(String((init as { body: string }).body)) as { to: string }[];
    return {
      ok: true,
      json: async () => ({ data: sent.map(() => ({ status: 'ok' })) }),
    } as Response;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

describe('Phase 2 sessions', () => {
  it('POST /api/sessions writes row and session.spawned, then calls Centaur spawn/message/execute', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'say PONG', harness: 'claude-code' },
    });

    expect(res.statusCode).toBe(201);
    const session = res.json().session;
    const row = await pool.query('SELECT * FROM sessions WHERE id = $1', [session.id]);
    expect(row.rowCount).toBe(1);
    const events = await pool.query('SELECT * FROM events WHERE type = $1', ['session.spawned']);
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].payload).toMatchObject({
      sessionId: session.id,
      title: 'say PONG',
      harness: 'claude-code',
    });

    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(true);
      expect(fake.requests.some((r) => r.path === '/agent/message')).toBe(true);
      expect(fake.requests.some((r) => r.path === '/agent/execute')).toBe(true);
    });
    const execute = fake.requests.find((r) => r.path === '/agent/execute');
    expect(execute?.body.environment).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-from-test' });
    await app.close();
  });

  it('rejects private repo spawn without a connected GitHub connection', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repos: [{ repo: 'acme/private', private: true }],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'github_connection_required' });
    expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(false);
    await app.close();
  });

  it('validates private repo access for a GitHub App installation before spawning', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId, 'app_installation', { installationId: '12345' });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    config.githubAppId = '98765';
    config.githubAppPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    config.githubAppPrivateKeyId = 'key-1';
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/app/installations/12345/access_tokens')) {
        return new Response(JSON.stringify({ token: 'installation-token' }), { status: 201 });
      }
      if (href.endsWith('/repos/acme/private')) {
        return new Response(JSON.stringify({ full_name: 'acme/private' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repos: [{ repo: 'acme/private', private: true }],
      },
    });

    expect(res.statusCode).toBe(201);
    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repoCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/repos/acme/private'));
    expect(repoCall?.[1]?.headers).toMatchObject({ authorization: 'Bearer installation-token' });
    await app.close();
  });

  it('rejects private repo spawn when the GitHub App installation cannot access the repo', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId, 'app_installation', { installationId: '12345' });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    config.githubAppId = '98765';
    config.githubAppPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/app/installations/12345/access_tokens')) {
        return new Response(JSON.stringify({ token: 'installation-token' }), { status: 201 });
      }
      if (href.endsWith('/repos/acme/private')) {
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repos: [{ repo: 'acme/private', private: true }],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'github_repo_inaccessible', repos: ['acme/private'] });
    expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(false);
    await app.close();
  });

  it('validates private repo access for GitHub App user credentials before spawning', async () => {
    const ironCalls: Array<{ url: string; init: RequestInit }> = [];
    const app = await buildApp({
      pool,
      ironControl: fakeIronControl(ironCalls),
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId, 'app_user', { brokerCredentialId: 'bcr_user_github' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repos: [{ repo: 'acme/private', private: true }],
      },
    });

    expect(res.statusCode).toBe(201);
    const validationCall = ironCalls.find((call) =>
      call.url.endsWith('/api/v1/broker_credentials/bcr_user_github/validate_github_repos'),
    );
    expect(validationCall).toBeDefined();
    expect(JSON.parse(String(validationCall?.init.body))).toEqual({
      data: { namespace: 'default', repos: ['acme/private'] },
    });
    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(true);
    });
    await app.close();
  });

  it('rejects private repo spawn when GitHub App user credentials cannot access the repo', async () => {
    const ironCalls: Array<{ url: string; init: RequestInit }> = [];
    const app = await buildApp({
      pool,
      ironControl: fakeIronControl(ironCalls, { inaccessibleGitHubRepos: ['acme/private'] }),
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId, 'app_user', { brokerCredentialId: 'bcr_user_github' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repos: [{ repo: 'acme/private', private: true }],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'github_repo_inaccessible', repos: ['acme/private'] });
    expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(false);
    await app.close();
  });

  it('rejects private repo spawn when GitHub App user credentials lack a broker credential id', async () => {
    const ironCalls: Array<{ url: string; init: RequestInit }> = [];
    const app = await buildApp({
      pool,
      ironControl: fakeIronControl(ironCalls),
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId, 'app_user');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repos: [{ repo: 'acme/private', private: true }],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'github_repo_access_unverified' });
    expect(ironCalls).toHaveLength(0);
    expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(false);
    await app.close();
  });

  it('validates private repo access for GitHub PAT credentials before spawning', async () => {
    const ironCalls: Array<{ url: string; init: RequestInit }> = [];
    const app = await buildApp({
      pool,
      ironControl: fakeIronControl(ironCalls),
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId, 'pat');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repos: [{ repo: 'acme/private', private: true }],
      },
    });

    expect(res.statusCode).toBe(201);
    const secretForeignId = githubPatSecretForeignId(fx.workspaceId, fx.userId);
    const validationCall = ironCalls.find((call) =>
      call.url.endsWith(`/api/v1/static_secrets/${secretForeignId}/validate_github_repos`),
    );
    expect(validationCall).toBeDefined();
    expect(JSON.parse(String(validationCall?.init.body))).toEqual({
      data: { namespace: 'default', repos: ['acme/private'] },
    });
    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(true);
    });
    await app.close();
  });

  it('rejects private repo spawn when GitHub PAT credentials cannot access the repo', async () => {
    const ironCalls: Array<{ url: string; init: RequestInit }> = [];
    const app = await buildApp({
      pool,
      ironControl: fakeIronControl(ironCalls, { inaccessibleGitHubRepos: ['acme/private'] }),
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId, 'pat');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repos: [{ repo: 'acme/private', private: true }],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'github_repo_inaccessible', repos: ['acme/private'] });
    expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(false);
    await app.close();
  });

  it('POST /api/sessions allows Claude Code without a subscription token', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'say PONG', harness: 'claude-code' },
    });

    expect(res.statusCode).toBe(201);
    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/execute')).toBe(true);
    });
    const execute = fake.requests.find((r) => r.path === '/agent/execute');
    expect(execute?.body.environment).toBeUndefined();
    await app.close();
  });

  it('POST /api/sessions allows Codex without auth JSON and injects it when connected', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const { cookie } = await loginUser(app, 'alice-codex', 'Alice Codex');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'say PONG', harness: 'codex' },
    });

    expect(missing.statusCode).toBe(201);
    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/execute')).toBe(true);
    });
    const firstExecute = fake.requests.find((r) => r.path === '/agent/execute');
    expect(firstExecute?.body.environment).toBeUndefined();

    await connectCodex(app, cookie);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'say PONG', harness: 'codex' },
    });

    expect(res.statusCode).toBe(201);
    await waitFor(() => {
      expect(fake.requests.filter((r) => r.path === '/agent/execute')).toHaveLength(2);
    });
    const executes = fake.requests.filter((r) => r.path === '/agent/execute');
    const execute = executes[executes.length - 1];
    expect(execute?.body.environment).toEqual({ CODEX_AUTH_JSON: TEST_CODEX_AUTH_JSON });
    await app.close();
  });

  it('POST /api/sessions binds a selected agent profile and injects its overlay', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const { cookie } = await loginUser(app, 'alice-profile-spawn', 'Alice Profile Spawn');

    const profileRes = await app.inject({
      method: 'POST',
      url: '/api/me/agent-profiles',
      headers: { cookie },
      payload: { provider: 'codex', name: 'Codex Saved' },
    });
    expect(profileRes.statusCode).toBe(200);
    const profileId = profileRes.json().profile.id as string;
    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/me/agent-profiles/${profileId}/versions`,
      headers: { cookie },
      payload: {
        provider: 'codex',
        adapterVersion: 'test',
        manifest: { settings: { model: 'gpt-5', model_reasoning_effort: 'high' } },
      },
    });
    expect(versionRes.statusCode).toBe(200);
    const versionId = versionRes.json().version.id as string;

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'codex',
        agentProfileId: profileId,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().session.agentProfileVersionId).toBe(versionId);
    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/execute')).toBe(true);
    });
    const execute = fake.requests.find((r) => r.path === '/agent/execute');
    expect(execute?.body.environment.CODEX_CONFIG_OVERLAY).toContain('model = "gpt-5"');
    expect(execute?.body.environment.CODEX_CONFIG_OVERLAY).toContain('model_reasoning_effort = "high"');
    await app.close();
  });

  it('rejects Codex auth JSON that contains an API key', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const { cookie } = await loginUser(app, 'alice-codex-bad', 'Alice Codex Bad');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/me/provider-credentials/codex',
      headers: { cookie },
      payload: {
        authJson: JSON.stringify({
          OPENAI_API_KEY: 'sk-test',
          auth_mode: 'chatgpt',
          tokens: { access_token: 'test-codex-access-token' },
        }),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('OPENAI_API_KEY');
    await app.close();
  });

  it('classifies Claude 401 output as provider auth required', async () => {
    fake.setFrames([
      {
        event: 'execution_state',
        event_id: 7,
        data: {
          type: 'execution.state',
          status: 'failed',
          result_text: 'Claude API Error: 401 Invalid bearer token',
        },
      },
    ]);
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'token-that-will-expire');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'auth will fail', harness: 'claude-code' },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().session.id;

    await waitFor(async () => {
      const row = await pool.query(
        `SELECT status, provider_auth_required
         FROM sessions
         WHERE id = $1`,
        [id],
      );
      expect(row.rows[0].status).toBe('queued');
      expect(row.rows[0].provider_auth_required).toMatchObject({
        provider: 'claude-code',
        reason: 'invalid_token',
      });
      const provider = await pool.query(
        `SELECT status, last_error
         FROM user_provider_credentials
         WHERE user_id = $1 AND provider = 'claude-code'`,
        [row.rows[0].provider_auth_required.userId],
      );
      expect(provider.rows[0]).toMatchObject({
        status: 'needs_auth',
        last_error: 'Claude Code authentication failed. Reconnect Claude to continue.',
      });
      const completed = await pool.query(`SELECT 1 FROM events WHERE type = 'session.completed'`);
      expect(completed.rowCount).toBe(0);
      const authEvent = await pool.query(
        `SELECT payload FROM events WHERE type = 'session.provider_auth_required'`,
      );
      expect(authEvent.rows[0].payload).toMatchObject({ sessionId: id, provider: 'claude-code' });
    });
    expect(fake.requests.some((r) => r.path.endsWith('/cancel'))).toBe(true);
    await app.close();
  });

  it('classifies Codex raw 401 output before a generic terminal failure as provider auth required', async () => {
    fake.setFrames([
      {
        event: 'execution_state',
        event_id: 9,
        data: {
          type: 'execution.state',
          status: 'running',
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 10,
        data: {
          method: 'error',
          params: {
            error: {
              message: 'Reconnecting... 2/5',
              codexErrorInfo: {
                responseStreamDisconnected: { httpStatusCode: 401 },
              },
              additionalDetails:
                'unexpected status 401 Unauthorized: Incorrect API key provided: OPENAI_A**_KEY, url: wss://api.openai.com/v1/responses',
            },
            willRetry: true,
          },
        },
      },
      {
        event: 'execution_state',
        event_id: 11,
        data: {
          type: 'execution.state',
          status: 'failed',
          error: 'terminal harness output reported failure',
        },
      },
    ]);
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const { cookie } = await loginUser(app, 'alice-codex-raw-auth', 'Alice Codex Raw Auth');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'auth will fail', harness: 'codex' },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().session.id;

    await waitFor(async () => {
      const row = await pool.query(
        `SELECT status, provider_auth_required
         FROM sessions
         WHERE id = $1`,
        [id],
      );
      expect(row.rows[0].status).toBe('queued');
      expect(row.rows[0].provider_auth_required).toMatchObject({
        provider: 'codex',
        reason: 'invalid_token',
      });
      const completed = await pool.query(`SELECT 1 FROM events WHERE type = 'session.completed'`);
      expect(completed.rowCount).toBe(0);
      const authEvent = await pool.query(
        `SELECT payload FROM events WHERE type = 'session.provider_auth_required'`,
      );
      expect(authEvent.rows[0].payload).toMatchObject({ sessionId: id, provider: 'codex' });
    });
    expect(fake.requests.some((r) => r.path.endsWith('/cancel'))).toBe(true);
    await app.close();
  });

  it('marks the GitHub connection needs_auth when private repo checkout authentication fails', async () => {
    fake.setFrames([
      {
        event: 'execution_state',
        event_id: 9,
        data: {
          type: 'execution.state',
          status: 'failed',
          result_text:
            "fatal: Authentication failed for 'https://github.com/acme/private.git' while using GITHUB_TOKEN",
        },
      },
    ]);
    const ironCalls: Array<{ url: string; init: RequestInit }> = [];
    const app = await buildApp({
      pool,
      ironControl: fakeIronControl(ironCalls),
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId, 'app_installation', { installationId: '12345' });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    config.githubAppId = '98765';
    config.githubAppPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.endsWith('/app/installations/12345/access_tokens')) {
          return new Response(JSON.stringify({ token: 'installation-token' }), { status: 201 });
        }
        if (href.endsWith('/repos/acme/private')) {
          return new Response(JSON.stringify({ full_name: 'acme/private' }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'checkout private repo',
        harness: 'claude-code',
        repos: [{ repo: 'acme/private', private: true }],
      },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().session.id;

    await waitFor(async () => {
      const row = await pool.query(
        `SELECT status, provider_auth_required
         FROM sessions
         WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]).toMatchObject({
        status: 'failed',
        provider_auth_required: null,
      });
      const connection = await pool.query(
        `SELECT status, token_kind, last_error
         FROM user_connections
         WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github'`,
        [fx.workspaceId, fx.userId],
      );
      expect(connection.rows[0]).toMatchObject({
        status: 'needs_auth',
        token_kind: 'app_installation',
        last_error: 'GitHub authentication failed. Reconnect GitHub before retrying private repository access.',
      });
      const authEvent = await pool.query(
        `SELECT payload FROM events WHERE type = 'session.github_auth_required'`,
      );
      expect(authEvent.rows[0].payload).toMatchObject({
        sessionId: id,
        provider: 'github',
        userId: fx.userId,
        reason: 'invalid_token',
      });
    });
    expect(ironCalls.map((call) => `${call.init.method ?? 'GET'} ${new URL(call.url).pathname}`)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^PUT \/api\/v1\/principals\//),
        expect.stringMatching(/^DELETE \/api\/v1\/static_secrets\//),
        expect.stringMatching(/^PUT \/api\/v1\/roles\/github-default$/),
        expect.stringMatching(/^POST \/api\/v1\/principals\/prn_atrium\/roles$/),
        expect.stringMatching(/\/effective_config$/),
      ]),
    );
    await app.close();
  });

  it('does not attach an execution when cancel wins the async session-start race', async () => {
    fake.pauseNextExecute();
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);

    const spawned = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'cancel before execute settles' },
    });
    const sessionId = spawned.json().session.id;

    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/execute')).toBe(true);
    });
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/cancel`,
      headers: { cookie },
      payload: { opId: randomUUID() },
    });
    expect(cancelled.statusCode).toBe(202);

    fake.releasePausedExecute();

    await waitFor(async () => {
      const row = await pool.query(
        'SELECT status, current_execution_id FROM sessions WHERE id = $1',
        [sessionId],
      );
      expect(row.rows[0]).toMatchObject({
        status: 'cancelled',
        current_execution_id: null,
      });
      expect(fake.acceptedExecutions).toHaveLength(1);
      expect(fake.requests.filter((r) => r.path.endsWith('/cancel'))).toHaveLength(2);
    });
    await app.close();
  });

  it('POST /api/sessions persists repo/branch and echoes them on the wire + spawned event', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'build it', repo: '  acme/app  ', branch: ' dev ' },
    });

    expect(res.statusCode).toBe(201);
    const session = res.json().session;
    // Trimmed on the wire.
    expect(session).toMatchObject({ repo: 'acme/app', branch: 'dev' });

    const row = await pool.query('SELECT repo, branch, session_repos FROM sessions WHERE id = $1', [session.id]);
    expect(row.rows[0]).toEqual({
      repo: 'acme/app',
      branch: 'dev',
      session_repos: [{ repo: 'acme/app', ref: 'dev' }],
    });

    const events = await pool.query('SELECT payload FROM events WHERE type = $1', [
      'session.spawned',
    ]);
    expect(events.rows[0].payload).toMatchObject({
      repo: 'acme/app',
      branch: 'dev',
      repos: [{ repo: 'acme/app', ref: 'dev' }],
    });
    await app.close();
  });

  it('forwards repo/branch to Centaur as a checkout spec on spawn', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repo: '  acme/app  ',
        branch: ' dev ',
      },
    });
    expect(res.statusCode).toBe(201);

    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(true);
    });
    const spawn = fake.requests.find((r) => r.path === '/agent/spawn');
    // Trimmed repo/branch become the RepoSpec Centaur folds into AGENT_REPOS_JSON.
    expect(spawn?.body).toMatchObject({ repos: [{ repo: 'acme/app', ref: 'dev' }] });
    expect(spawn?.body.metadata).toMatchObject({
      source: 'atrium',
      harness: 'claude-code',
      atrium_workspace_id: fx.workspaceId,
      atrium_user_id: fx.userId,
      credential_owner_user_id: fx.userId,
      github_identity_mode: 'automatic',
    });
    await app.close();
  });

  it('persists and forwards multi-repo checkout specs', async () => {
    const ironCalls: Array<{ url: string; init: RequestInit }> = [];
    const app = await buildApp({
      pool,
      ironControl: fakeIronControl(ironCalls),
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repos: [
          { repo: ' acme/app ', ref: ' main ', private: true },
          { repo: 'acme/docs', subdir: 'docs' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const validationCall = ironCalls.find((call) => call.url.includes('/validate_github_repos'));
    expect(JSON.parse(String(validationCall?.init.body))).toMatchObject({
      data: { repos: ['acme/app'] },
    });
    expect(res.json().session).toMatchObject({
      repo: 'acme/app',
      branch: 'main',
      repos: [
        { repo: 'acme/app', ref: 'main', private: true },
        { repo: 'acme/docs', subdir: 'docs' },
      ],
    });

    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(true);
    });
    const spawn = fake.requests.find((r) => r.path === '/agent/spawn');
    expect(spawn?.body).toMatchObject({
      repos: [
        { repo: 'acme/app', ref: 'main', private: true },
        { repo: 'acme/docs', subdir: 'docs' },
      ],
    });
    await app.close();
  });

  it('persists and forwards a selected GitHub identity override', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId, 'app_installation');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repo: 'acme/app',
        githubIdentityMode: 'app_installation',
      },
    });
    expect(res.statusCode).toBe(201);
    const session = res.json().session;
    expect(session).toMatchObject({
      githubIdentityMode: 'app_installation',
      providerConnectionId: 'github',
    });

    const row = await pool.query(
      'SELECT provider_connection_id, github_identity_mode FROM sessions WHERE id = $1',
      [session.id],
    );
    expect(row.rows[0]).toEqual({
      provider_connection_id: 'github',
      github_identity_mode: 'app_installation',
    });

    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(true);
    });
    const spawn = fake.requests.find((r) => r.path === '/agent/spawn');
    expect(spawn?.body.metadata).toMatchObject({
      github_identity_mode: 'app_installation',
      provider_connection_id: 'github',
    });
    await app.close();
  });

  it('rejects a GitHub identity override that is not connected for the user', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');
    await connectGitHubMetadata(fx.workspaceId, fx.userId, 'pat');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: {
        channelId: fx.channelId,
        task: 'say PONG',
        harness: 'claude-code',
        repo: 'acme/app',
        githubIdentityMode: 'app_user',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'github_identity_unavailable' });
    expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(false);
    await app.close();
  });

  it('omits repos from the spawn when no repo is set', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    await connectClaude(app, cookie, 'oauth-from-test');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'say PONG', harness: 'claude-code' },
    });
    expect(res.statusCode).toBe(201);

    await waitFor(() => {
      expect(fake.requests.some((r) => r.path === '/agent/spawn')).toBe(true);
    });
    const spawn = fake.requests.find((r) => r.path === '/agent/spawn');
    expect(spawn?.body).not.toHaveProperty('repos');
    await app.close();
  });

  it('POST /api/sessions defaults repo/branch to null when omitted', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'no repo' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().session).toMatchObject({ repo: null, branch: null });
    await app.close();
  });

  it('dedupes duplicate POST /api/sessions by clientSpawnId', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const payload = {
      channelId: fx.channelId,
      task: 'dedupe this spawn',
      clientSpawnId: 'pending:test-spawn-1',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().session.id).toBe(first.json().session.id);
    const rows = await pool.query('SELECT id FROM sessions WHERE client_spawn_id = $1', [
      payload.clientSpawnId,
    ]);
    expect(rows.rowCount).toBe(1);
    const events = await pool.query(
      `SELECT id, payload FROM events
       WHERE type = 'session.spawned' AND payload->>'client_spawn_id' = $1`,
      [payload.clientSpawnId],
    );
    expect(events.rowCount).toBe(1);
    await waitFor(() => {
      expect(fake.requests.filter((r) => r.path === '/agent/spawn')).toHaveLength(1);
      expect(fake.requests.filter((r) => r.path === '/agent/message')).toHaveLength(1);
      expect(fake.requests.filter((r) => r.path === '/agent/execute')).toHaveLength(1);
    });
    await app.close();
  });

  it('tailer folds A_pong into completed session state and lifecycle event', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie },
      payload: { channelId: fx.channelId, task: 'say PONG' },
    });
    const id = res.json().session.id;

    await waitFor(async () => {
      const row = await pool.query('SELECT status, result_text, last_event_id FROM sessions WHERE id = $1', [id]);
      expect(row.rows[0].status).toBe('completed');
      expect(row.rows[0].result_text).toContain('PONG');
      expect(row.rows[0].last_event_id).toBe(54);
      const event = await pool.query('SELECT payload FROM events WHERE type = $1', ['session.completed']);
      expect(event.rows[0].payload).toMatchObject({
        sessionId: id,
        status: 'completed',
        resultExcerpt: 'PONG',
        permalink: `/s/${id}`,
      });
    });
    await app.close();
  });

  it('mirrors streamed frames verbatim, including ignored and duplicate frames', async () => {
    const frames = [
      {
        event: 'usage_observed',
        event_id: 10,
        data: { type: 'usage_observed', cost_usd: 1.25 },
      },
      {
        event: 'amp_raw_event',
        event_id: 11,
        data: {
          type: 'codex.item.agentMessage.delta',
          item_id: 'item-1',
          delta: 'raw transcript fragment',
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 11,
        data: {
          type: 'codex.item.agentMessage.delta',
          item_id: 'item-1',
          delta: 'raw transcript fragment',
        },
      },
      {
        event: 'execution_state',
        event_id: 12,
        data: {
          type: 'execution.state',
          status: 'completed',
          thread_key: 'thread',
          execution_id: 'exe_fake',
          result_text: 'mirror complete',
        },
      },
    ];
    fake.setFrames(frames);
    const id = await insertSessionRow({ title: 'mirror stream', status: 'running' });
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: true },
    });
    await app.ready();

    await waitFor(async () => {
      const session = await pool.query(
        'SELECT status, result_text, last_event_id, cost_usd FROM sessions WHERE id = $1',
        [id],
      );
      expect(session.rows[0]).toMatchObject({
        status: 'completed',
        result_text: 'mirror complete',
      });
      expect(Number(session.rows[0].last_event_id)).toBe(12);
      expect(Number(session.rows[0].cost_usd)).toBe(1.25);

      const mirrored = await pool.query(
        `SELECT session_id, centaur_event_id, event_kind, frame, created_at
         FROM session_events
         WHERE session_id = $1
         ORDER BY centaur_event_id`,
        [id],
      );
      expect(mirrored.rowCount).toBe(3);
      expect(mirrored.rows.map((row) => Number(row.centaur_event_id))).toEqual([10, 11, 12]);
      expect(mirrored.rows.map((row) => row.event_kind)).toEqual([
        'usage_observed',
        'amp_raw_event',
        'execution_state',
      ]);
      expect(mirrored.rows.map((row) => row.frame)).toEqual([frames[0], frames[1], frames[3]]);
      expect(mirrored.rows.every((row) => row.session_id === id && row.created_at instanceof Date)).toBe(true);

      const completed = await pool.query('SELECT payload FROM events WHERE type = $1', [
        'session.completed',
      ]);
      expect(completed.rowCount).toBe(1);
      expect(completed.rows[0].payload).toMatchObject({
        sessionId: id,
        status: 'completed',
        resultExcerpt: 'mirror complete',
      });
    });
    await app.close();
  });

  it('GET /api/sessions/:id/stream replays mirrored history before tailing current execution', async () => {
    const id = await insertSessionRow({ title: 'stream replay', status: 'running', currentExecutionId: 'exe_live' });
    await pool.query(
      `INSERT INTO session_events (session_id, centaur_event_id, event_kind, frame)
       VALUES ($1, 10, 'amp_raw_event', $2), ($1, 20, 'execution_state', $3)`,
      [
        id,
        {
          event: 'amp_raw_event',
          event_id: 10,
          data: {
            method: 'item/completed',
            params: { item: { id: 'u-old', type: 'userMessage', text: 'old turn' } },
          },
        },
        {
          event: 'execution_state',
          event_id: 20,
          data: { type: 'execution.state', status: 'completed', result_text: 'old result' },
        },
      ],
    );
    fake.setFrames([
      {
        event: 'amp_raw_event',
        event_id: 21,
        data: {
          method: 'item/completed',
          params: { item: { id: 'u-live', type: 'userMessage', text: 'live turn' } },
        },
      },
      {
        event: 'execution_state',
        event_id: 22,
        data: { type: 'execution.state', status: 'completed', result_text: 'live result' },
      },
    ]);
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/stream?after_event_id=0`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(fake.streamAfterIds.at(-1)).toBe(20);
    expect(res.body.indexOf('old turn')).toBeLessThan(res.body.indexOf('old result'));
    expect(res.body.indexOf('old result')).toBeLessThan(res.body.indexOf('live turn'));

    await app.close();
  });

  it('GET /api/sessions/:id/stream closes after replay for a terminal session instead of tailing forever', async () => {
    const id = await insertSessionRow({ title: 'terminal replay', status: 'completed', currentExecutionId: 'exe_done' });
    await pool.query(
      `INSERT INTO session_events (session_id, centaur_event_id, event_kind, frame)
       VALUES ($1, 10, 'amp_raw_event', $2), ($1, 20, 'execution_state', $3)`,
      [
        id,
        {
          event: 'amp_raw_event',
          event_id: 10,
          data: {
            method: 'item/completed',
            params: { item: { id: 'u-old', type: 'userMessage', text: 'old turn' } },
          },
        },
        {
          event: 'execution_state',
          event_id: 20,
          data: { type: 'execution.state', status: 'completed', result_text: 'old result' },
        },
      ],
    );
    // No live frames: the fake's /events endpoint returns nothing for any
    // after_event_id. If streamCentaurEvents tailed live here, tailEvents would
    // reconnect-poll forever and this request would never resolve.
    fake.setFrames([]);
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/stream?after_event_id=0`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    // Mirror was replayed to the client...
    expect(res.body).toContain('old turn');
    expect(res.body).toContain('old result');
    // ...but the live Centaur events endpoint was never tailed (it would hang on
    // a terminal session whose terminal frame is already behind the cursor).
    expect(fake.streamAfterIds).toHaveLength(0);

    await app.close();
  });

  it('boot resume tails a running session to completion', async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, 'thread-resume', 'claude-code', 'resume me', 'running', $3, $3, 'exe_fake', 1)
       RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: true },
    });
    await app.ready();

    await waitFor(async () => {
      const row = await pool.query('SELECT status, result_text FROM sessions WHERE id = $1', [
        inserted.rows[0]!.id,
      ]);
      expect(row.rows[0].status).toBe('completed');
      expect(row.rows[0].result_text).toContain('PONG');
    });
    await app.close();
  });

  it('folds question_requested into pending state and a thread event', async () => {
    fake.setFrames([questionRequestedFrame()]);
    const id = await insertSessionRow({ title: 'needs input', status: 'running' });
    // Real sessions are thread-rooted; the question event must land as a
    // thread child that thread reads return.
    const root = await pool.query<{ id: number }>(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       VALUES ($1, $2, 'session.spawned', $3, '{}'::jsonb) RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const rootId = root.rows[0]!.id;
    await pool.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [rootId, id]);
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: true },
    });
    await app.ready();

    await waitFor(async () => {
      const row = await pool.query('SELECT pending_question, last_event_id FROM sessions WHERE id = $1', [id]);
      expect(row.rows[0].pending_question).toMatchObject({
        questionId: 'q-main',
        turnId: 'turn-1',
        questions: [{ id: 'choice', header: 'Decision' }],
      });
      expect(Number(row.rows[0].last_event_id)).toBe(1);
      const event = await pool.query('SELECT thread_root_event_id, payload FROM events WHERE type = $1', [
        'session.question_requested',
      ]);
      expect(event.rowCount).toBe(1);
      expect(event.rows[0].payload).toMatchObject({
        sessionId: id,
        questionId: 'q-main',
        permalink: `/s/${id}`,
        questions: [
          {
            id: 'choice',
            header: 'Decision',
            question: 'Which deployment path should I take?',
            options: [
              { label: 'Fast', description: 'Ship the smallest change' },
              { label: 'Careful', description: 'Run the full suite first' },
            ],
          },
        ],
      });
    });

    // Thread reads must return the question event (not just live WS push) —
    // otherwise reloads/thread fetches silently drop it.
    const cookie = await loginCookie(app);
    const thread = await app.inject({
      method: 'GET',
      url: `/api/threads/${rootId}/messages`,
      headers: { cookie },
    });
    expect(thread.statusCode).toBe(200);
    const types = (thread.json().events as { type: string }[]).map((e) => e.type);
    expect(types).toContain('session.question_requested');

    // The question must also count as a reply so the thread affordance
    // survives a reload (reply_count previously counted only message.posted).
    const channel = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages`,
      headers: { cookie },
    });
    const rootRow = (channel.json().events as { id: number; replyCount?: number }[]).find(
      (e) => e.id === rootId,
    );
    expect(rootRow?.replyCount).toBe(1);
    await app.close();
  });

  it('renotifies once when a question is still unanswered', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator]');
    const fetchImpl = okPushFetch();
    fake.setFrames([questionRequestedFrame()]);
    const id = await insertSessionRow({ title: 'needs input', status: 'running' });
    const app = await buildApp({
      pool,
      sessionRuns: {
        baseUrl: fake.url,
        apiKey: 'test',
        autoResume: true,
        questionRenotifyMinutes: 0.001,
        questionPushFetchImpl: fetchImpl,
      },
    });
    await app.ready();

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2), 2000);
    const first = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    const second = JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string);
    expect(first[0].data).toMatchObject({ sessionId: id, questionId: 'q-main' });
    expect(second[0].data).toMatchObject({ sessionId: id, questionId: 'q-main' });
    await app.close();
  });

  it('cancels question renotify when the question is answered before the deadline', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator]');
    const fetchImpl = okPushFetch();
    fake.setFrames([questionRequestedFrame()]);
    const id = await insertSessionRow({ title: 'answer before renotify', status: 'running' });
    const app = await buildApp({
      pool,
      sessionRuns: {
        baseUrl: fake.url,
        apiKey: 'test',
        autoResume: true,
        questionRenotifyMinutes: 0.01,
        questionPushFetchImpl: fetchImpl,
      },
    });
    await app.ready();
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const cookie = await loginCookie(app);

    const answer = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/answer`,
      headers: { cookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });

    expect(answer.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('does not send a stale renotify when pending_question changed', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator]');
    const fetchImpl = okPushFetch();
    fake.setFrames([questionRequestedFrame()]);
    const id = await insertSessionRow({ title: 'stale question', status: 'running' });
    const app = await buildApp({
      pool,
      sessionRuns: {
        baseUrl: fake.url,
        apiKey: 'test',
        autoResume: true,
        questionRenotifyMinutes: 0.01,
        questionPushFetchImpl: fetchImpl,
      },
    });
    await app.ready();
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    await pool.query(
      `UPDATE sessions SET pending_question = $1 WHERE id = $2`,
      [
        JSON.stringify({
          questionId: 'q-other',
          turnId: 'turn-2',
          eventId: 2,
          questions: questionRequestedFrame(2).data.questions,
        }),
        id,
      ],
    );

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('channel after_id catch-up returns session question events with payloads intact', async () => {
    const id = await insertSessionRow({ title: 'needs input', status: 'running' });
    const root = await pool.query<{ id: number }>(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       VALUES ($1, $2, 'session.spawned', $3, $4) RETURNING id`,
      [
        fx.workspaceId,
        fx.channelId,
        fx.userId,
        JSON.stringify({ sessionId: id, title: 'needs input' }),
      ],
    );
    const rootId = root.rows[0]!.id;
    await pool.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [rootId, id]);
    const requestedPayload = {
      sessionId: id,
      questionId: 'q-main',
      questions: questionRequestedFrame().data.questions,
      permalink: `/s/${id}`,
    };
    const answeredPayload = {
      sessionId: id,
      questionId: 'q-main',
      answers: { choice: 'Fast' },
      answeredBy: fx.userId,
    };
    const resolvedPayload = {
      sessionId: id,
      questionId: 'q-main',
      reason: 'answered',
    };
    for (const [type, payload] of [
      ['session.question_requested', requestedPayload],
      ['session.question_answered', answeredPayload],
      ['session.question_resolved', resolvedPayload],
    ] as const) {
      await pool.query(
        `INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [fx.workspaceId, fx.channelId, rootId, type, fx.userId, JSON.stringify(payload)],
      );
    }

    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages?after_id=${rootId}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const events = res.json().events as {
      type: string;
      threadRootEventId: number | null;
      payload: Record<string, unknown>;
    }[];
    expect(events.map((e) => e.type)).toEqual([
      'session.question_requested',
      'session.question_answered',
      'session.question_resolved',
    ]);
    expect(events.every((e) => e.threadRootEventId === rootId)).toBe(true);
    expect(events[0]!.payload).toEqual(requestedPayload);
    expect(events[1]!.payload).toEqual(answeredPayload);
    expect(events[2]!.payload).toEqual(resolvedPayload);
    await app.close();
  });

  it('GET /api/sessions/:id includes pendingQuestion', async () => {
    const id = await insertSessionRow({ title: 'pending get', status: 'running' });
    await setPendingQuestion(id);
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json().session.pendingQuestion).toMatchObject({
      questionId: 'q-main',
      questions: [{ id: 'choice', header: 'Decision' }],
    });
    await app.close();
  });

  it('answer route is driver-only, requires matching pending question, posts to Centaur, clears, and emits', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const driverCookie = await loginCookie(app);
    const other = await loginUser(app, 'bob', 'Bob');
    const id = await insertSessionRow({ title: 'answer me', status: 'running' });
    await setPendingQuestion(id);

    const denied = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/answer`,
      headers: { cookie: other.cookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });
    expect(denied.statusCode).toBe(403);

    const noPendingId = await insertSessionRow({ title: 'no pending', status: 'running' });
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/sessions/${noPendingId}/answer`,
      headers: { cookie: driverCookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });
    expect(conflict.statusCode).toBe(409);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/answer`,
      headers: { cookie: driverCookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });
    expect(ok.statusCode).toBe(202);
    expect(fake.answers).toHaveLength(1);
    expect(fake.answers[0]!.path).toContain('/api/session/thread-');
    expect(fake.answers[0]!.path).toContain('/executions/exe_fake/answer');
    expect(fake.answers[0]!.body).toEqual({
      question_id: 'q-main',
      answers: { choice: { answers: ['Fast'] } },
    });
    const row = await pool.query('SELECT pending_question FROM sessions WHERE id = $1', [id]);
    expect(row.rows[0].pending_question).toBeNull();
    const event = await pool.query('SELECT actor_id, payload FROM events WHERE type = $1', [
      'session.question_answered',
    ]);
    expect(event.rowCount).toBe(1);
    expect(event.rows[0].actor_id).toBe(fx.userId);
    expect(event.rows[0].payload).toMatchObject({
      sessionId: id,
      questionId: 'q-main',
      by: fx.userId,
    });

    const second = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/answer`,
      headers: { cookie: driverCookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Careful'] } } },
    });
    expect(second.statusCode).toBe(409);
    expect(fake.answers).toHaveLength(1);
    const answeredEvents = await pool.query('SELECT id FROM events WHERE type = $1', [
      'session.question_answered',
    ]);
    expect(answeredEvents.rowCount).toBe(1);
    await app.close();
  });

  it('answer route returns 404 when the driver no longer has private channel access', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'priv-answers',
      actorId: alice.userId,
      private: true,
    });
    const id = await insertSessionRow({
      channelId: channel.id,
      title: 'private answer',
      status: 'running',
      spawnedBy: alice.userId,
    });
    await setPendingQuestion(id);
    await pool.query('DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [
      channel.id,
      alice.userId,
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/answer`,
      headers: { cookie: alice.cookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });

    expect(res.statusCode).toBe(404);
    expect(fake.answers).toHaveLength(0);
    await app.close();
  });

  it('clears a locally pending question when Centaur reports it is no longer pending', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const driverCookie = await loginCookie(app);
    const id = await insertSessionRow({ title: 'lapsed answer', status: 'running' });
    await setPendingQuestion(id);
    fake.rejectNextAnswerQuestionNotPending();

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/answer`,
      headers: { cookie: driverCookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('question_not_pending');
    const row = await pool.query('SELECT pending_question FROM sessions WHERE id = $1', [id]);
    expect(row.rows[0].pending_question).toBeNull();
    const resolved = await pool.query('SELECT payload FROM events WHERE type = $1', [
      'session.question_resolved',
    ]);
    expect(resolved.rowCount).toBe(1);
    expect(resolved.rows[0].payload).toMatchObject({
      sessionId: id,
      questionId: 'q-main',
      reason: 'empty',
    });
    const answered = await pool.query('SELECT id FROM events WHERE type = $1', [
      'session.question_answered',
    ]);
    expect(answered.rowCount).toBe(0);
    await app.close();
  });

  it('clears a locally pending question when an idempotent answer op races a stale Centaur question', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const driverCookie = await loginCookie(app);
    const id = await insertSessionRow({ title: 'lapsed answer op', status: 'running' });
    await setPendingQuestion(id);
    fake.rejectNextAnswerQuestionNotPending();

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/answer`,
      headers: { cookie: driverCookie },
      payload: {
        questionId: 'q-main',
        answers: { choice: { answers: ['Fast'] } },
        opId: randomUUID(),
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('question_not_pending');
    const row = await pool.query('SELECT pending_question FROM sessions WHERE id = $1', [id]);
    expect(row.rows[0].pending_question).toBeNull();
    const resolved = await pool.query('SELECT payload FROM events WHERE type = $1', [
      'session.question_resolved',
    ]);
    expect(resolved.rowCount).toBe(1);
    expect(resolved.rows[0].payload).toMatchObject({
      sessionId: id,
      questionId: 'q-main',
      reason: 'empty',
    });
    const answered = await pool.query('SELECT id FROM events WHERE type = $1', [
      'session.question_answered',
    ]);
    expect(answered.rowCount).toBe(0);
    await app.close();
  });

  it('question_resolved(cancelled) clears pending state and emits a follow-up event', async () => {
    fake.setFrames([questionRequestedFrame(1), questionResolvedFrame('cancelled', 2)]);
    const id = await insertSessionRow({ title: 'cancelled question', status: 'running' });
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: true },
    });
    await app.ready();

    await waitFor(async () => {
      const row = await pool.query('SELECT pending_question FROM sessions WHERE id = $1', [id]);
      expect(row.rows[0].pending_question).toBeNull();
      const event = await pool.query('SELECT payload FROM events WHERE type = $1', [
        'session.question_resolved',
      ]);
      expect(event.rowCount).toBe(1);
      expect(event.rows[0].payload).toMatchObject({
        sessionId: id,
        questionId: 'q-main',
        reason: 'cancelled',
      });
    });
    await app.close();
  });

  it('terminal execution_state clears pending question', async () => {
    fake.setFrames([
      questionRequestedFrame(1),
      {
        event: 'execution_state',
        event_id: 2,
        data: {
          type: 'execution.state',
          status: 'completed',
          thread_key: 'thread',
          execution_id: 'exe_fake',
          result_text: 'done',
        },
      },
    ]);
    const id = await insertSessionRow({ title: 'terminal clears', status: 'running' });
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: true },
    });
    await app.ready();

    await waitFor(async () => {
      const row = await pool.query('SELECT status, pending_question FROM sessions WHERE id = $1', [id]);
      expect(row.rows[0].status).toBe('completed');
      expect(row.rows[0].pending_question).toBeNull();
    });
    await app.close();
  });

  describe('boot release sweep', () => {
    let previousReleaseIdleMs: string | undefined;

    beforeEach(() => {
      previousReleaseIdleMs = process.env.SESSION_RELEASE_IDLE_MS;
      process.env.SESSION_RELEASE_IDLE_MS = '10';
    });

    afterEach(() => {
      if (previousReleaseIdleMs === undefined) delete process.env.SESSION_RELEASE_IDLE_MS;
      else process.env.SESSION_RELEASE_IDLE_MS = previousReleaseIdleMs;
    });

    it('schedules release for terminal sessions with pinned assignments on boot', async () => {
      const id = await insertSessionRow({
        title: 'release on boot',
        status: 'completed',
        completedAt: new Date().toISOString(),
        assignmentGeneration: 7,
      });
      const app = await buildApp({
        pool,
        sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: true },
      });
      await app.ready();

      await waitFor(async () => {
        const row = await pool.query('SELECT assignment_generation FROM sessions WHERE id = $1', [id]);
        expect(row.rows[0].assignment_generation).toBeNull();
      });
      expect(fake.requests.some((r) => r.path.endsWith('/release'))).toBe(false);
      await app.close();
    });

    it('does not release terminal sessions whose assignment is already null on boot', async () => {
      await insertSessionRow({
        title: 'already released',
        status: 'completed',
        completedAt: new Date().toISOString(),
        assignmentGeneration: null,
      });
      const app = await buildApp({
        pool,
        sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: true },
      });
      await app.ready();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.requests.some((r) => r.path.endsWith('/release'))).toBe(false);
      await app.close();
    });

    it('does not release non-terminal sessions during the boot sweep', async () => {
      fake.clearFrames();
      const id = await insertSessionRow({
        title: 'still running',
        status: 'running',
        assignmentGeneration: 4,
      });
      const app = await buildApp({
        pool,
        sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: true },
      });
      await app.ready();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.requests.some((r) => r.path.endsWith('/release'))).toBe(false);
      const row = await pool.query('SELECT status, assignment_generation FROM sessions WHERE id = $1', [id]);
      expect(row.rows[0]).toMatchObject({ status: 'running', assignment_generation: 4 });
      await app.close();
    });
  });

  it('boot resume reuses pending execute id after execute accept was not persisted', async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation, centaur_execute_id, centaur_execute_attempt
       )
       VALUES ($1, $2, 'thread-crash-exec', 'claude-code', 'resume execute', 'queued', $3, $3, NULL, 1, '', 1)
       RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const id = inserted.rows[0]!.id;
    const executeId = `exec-${id}-a1`;
    await pool.query('UPDATE sessions SET centaur_execute_id = $1 WHERE id = $2', [executeId, id]);
    fake.seedAcceptedExecute(
      'thread-crash-exec',
      executeId,
      {
        thread_key: 'thread-crash-exec',
        assignment_generation: 1,
        harness: 'claude-code',
        delivery: { platform: 'dev' },
        execute_id: executeId,
      },
      { execution_id: 'exe_crashed' },
    );

    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: true },
    });
    await app.ready();

    await waitFor(async () => {
      const row = await pool.query(
        'SELECT current_execution_id, centaur_execute_id FROM sessions WHERE id = $1',
        [id],
      );
      expect(row.rows[0].current_execution_id).toBe('exe_crashed');
      expect(row.rows[0].centaur_execute_id).toBeNull();
    });
    expect(fake.acceptedExecutions).toEqual(['exe_crashed']);
    const executes = fake.requests.filter((r) => r.path === '/agent/execute');
    expect(executes).toHaveLength(1);
    expect(executes[0]!.body.execute_id).toBe(executeId);
    await app.close();
  });

  it('steer after release uses a fresh spawn id', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation, centaur_spawn_attempt
       )
       VALUES ($1, $2, 'thread-released', 'claude-code', 'released', 'completed', $3, $3, 'exe_done', NULL, 1)
       RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const id = inserted.rows[0]!.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/messages`,
      headers: { cookie },
      payload: { text: 'resume released assignment' },
    });

    expect(res.statusCode).toBe(202);
    const spawn = fake.requests.find((r) => r.path === '/agent/spawn');
    expect(spawn?.body.spawn_id).toBe(`spawn-${id}-a2`);
    expect(spawn?.body.spawn_id).not.toBe(`spawn-${id}-a1`);
    await app.close();
  });

  it('steer mints a fresh execute id when a crashed steer left one pending', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation, centaur_execute_attempt
       )
       VALUES ($1, $2, 'thread-pending-exec', 'claude-code', 'pending exec', 'completed', $3, $3, 'exe_done', 1, 1)
       RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const id = inserted.rows[0]!.id;
    await pool.query('UPDATE sessions SET centaur_execute_id = $1 WHERE id = $2', [`exec-${id}-a1`, id]);
    fake.setThreadGeneration('thread-pending-exec', 1);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/messages`,
      headers: { cookie },
      payload: { text: 'steer past the crashed turn' },
    });

    expect(res.statusCode).toBe(202);
    const execute = fake.requests.find((r) => r.path === '/agent/execute');
    expect(execute?.body.execute_id).toBe(`exec-${id}-a2`);
    await app.close();
  });

  it('steer with NEW text mints a fresh message id when a pending id holds different content', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation, centaur_message_attempt
       )
       VALUES ($1, $2, 'thread-wedged-msg', 'claude-code', 'wedged msg', 'running', $3, $3, 'exe_old', 1, 1)
       RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const id = inserted.rows[0]!.id;
    fake.setThreadGeneration('thread-wedged-msg', 1);
    // Simulate an earlier steer whose message Centaur accepted (idempotency
    // row recorded) but whose execute never persisted: the pending id holds
    // the OLD text.
    await pool.query('UPDATE sessions SET centaur_message_id = $1 WHERE id = $2', [`msg-${id}-a1`, id]);
    const seeded = await fetch(`${fake.url}/agent/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        thread_key: 'thread-wedged-msg',
        assignment_generation: 1,
        role: 'user',
        parts: [{ type: 'text', text: 'the earlier, different steer text' }],
        metadata: { user_id: fx.userId },
        user_id: fx.userId,
        message_id: `msg-${id}-a1`,
      }),
    });
    expect(seeded.status).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/messages`,
      headers: { cookie },
      payload: { text: 'a brand new steer' },
    });

    expect(res.statusCode).toBe(202);
    const messages = fake.requests.filter((r) => r.path === '/agent/message');
    // seed + wedged attempt (mismatch) + fresh retry
    expect(messages.at(-1)!.body.message_id).toBe(`msg-${id}-a2`);
    const row = await pool.query('SELECT centaur_message_id, current_execution_id FROM sessions WHERE id = $1', [id]);
    expect(row.rows[0].centaur_message_id).toBeNull();
    expect(row.rows[0].current_execution_id).toBe('exe_fake_1');
    await app.close();
  });

  it('steer reuses a pending message id after Centaur accepted the message before a crash', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation, centaur_message_attempt
       )
       VALUES ($1, $2, 'thread-pending-message', 'claude-code', 'pending message', 'running', $3, $3, 'exe_old', 1, 1)
       RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const id = inserted.rows[0]!.id;
    const messageId = `msg-${id}-a1`;
    await pool.query('UPDATE sessions SET centaur_message_id = $1 WHERE id = $2', [messageId, id]);
    fake.seedAcceptedMessage('thread-pending-message', messageId, {
      thread_key: 'thread-pending-message',
      assignment_generation: 1,
      role: 'user',
      parts: [{ type: 'text', text: 'retry the accepted message' }],
      metadata: { user_id: fx.userId },
      user_id: fx.userId,
      message_id: messageId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/messages`,
      headers: { cookie },
      payload: { text: 'retry the accepted message' },
    });

    expect(res.statusCode).toBe(202);
    const message = fake.requests.find((r) => r.path === '/agent/message');
    expect(message?.body.message_id).toBe(messageId);
    expect(fake.acceptedMessages).toEqual([messageId]);
    const row = await pool.query('SELECT centaur_message_id, current_execution_id FROM sessions WHERE id = $1', [
      id,
    ]);
    expect(row.rows[0].centaur_message_id).toBeNull();
    expect(row.rows[0].current_execution_id).toBe('exe_fake_1');
    await app.close();
  });

  it('re-spawns and retries once when postMessage sees stale assignment generation', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, 'thread-stale', 'claude-code', 'stale', 'running', $3, $3, 'exe_old', 1)
       RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const id = inserted.rows[0]!.id;
    fake.setThreadGeneration('thread-stale', 1);
    fake.staleMessages.add('thread-stale');

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/messages`,
      headers: { cookie },
      payload: { text: 'retry after stale' },
    });

    expect(res.statusCode).toBe(202);
    const messages = fake.requests.filter((r) => r.path === '/agent/message');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.body.assignment_generation).toBe(1);
    expect(messages[1]!.body.assignment_generation).toBe(2);
    const spawn = fake.requests.find((r) => r.path === '/agent/spawn');
    expect(spawn?.body.spawn_id).toBe(`spawn-${id}-a1`);
    const row = await pool.query(
      'SELECT assignment_generation, current_execution_id FROM sessions WHERE id = $1',
      [id],
    );
    expect(row.rows[0].assignment_generation).toBe(1);
    expect(row.rows[0].current_execution_id).toBe('exe_fake_1');
    await app.close();
  });

  it('stream proxy rejects unauthenticated clients and streams Centaur frames with cookie', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, 'thread-stream', 'claude-code', 'stream me', 'running', $3, $3, 'exe_fake', 1)
       RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const id = inserted.rows[0]!.id;

    const unauthorized = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/stream`,
    });
    expect(unauthorized.statusCode).toBe(401);

    const streamed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/stream?after_event_id=52`,
      headers: { cookie },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain('event: execution_summary');
    expect(streamed.body).toContain('"event_id":54');
    await waitFor(async () => {
      const views = await pool.query(
        'SELECT session_id, user_id, opened_at, closed_at FROM session_views WHERE session_id = $1',
        [id],
      );
      expect(views.rows).toHaveLength(1);
      expect(views.rows[0]).toMatchObject({ session_id: id, user_id: fx.userId });
      expect(views.rows[0].opened_at).toBeInstanceOf(Date);
      expect(views.rows[0].closed_at).toBeInstanceOf(Date);
    });
    await app.close();
  });

  it('stream proxy resumes from after_event_id mid-history without replaying older frames', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const id = await insertRunningSession();

    const streamed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/stream?after_event_id=50`,
      headers: { cookie },
    });

    expect(streamed.statusCode).toBe(200);
    const eventIds = sseEventIds(streamed.body);
    expect(eventIds).toEqual([51, 52, 53, 54]);
    expect(fake.streamAfterIds[0]).toBe(50);
    await app.close();
  });

  it('stream proxy rejects garbage cursors and survives stale cursors beyond history', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const id = await insertRunningSession();

    const bad = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/stream?after_event_id=wat`,
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(400);

    fake.streamResetBeyondHistory = true;
    const stale = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/stream?after_event_id=999999`,
      headers: { cookie },
    });
    expect(stale.statusCode).toBe(200);
    expect(sseEventIds(stale.body)[0]).toBe(40);
    expect(sseEventIds(stale.body).at(-1)).toBe(54);
    expect(fake.streamAfterIds).toContain(999999);
    await app.close();
  });

  it('stream proxy closes cleanly after terminal session state', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const id = await insertRunningSession();

    const streamed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/stream?after_event_id=53`,
      headers: { cookie },
    });

    expect(streamed.statusCode).toBe(200);
    expect(sseEventIds(streamed.body)).toEqual([54]);
    expect(streamed.body).toContain('"status":"completed"');
    await app.close();
  });

  it('stream proxy tears down the Centaur iterator when the client disconnects', async () => {
    fake.streamHangOpen = true;
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('test app did not bind tcp');
    const cookie = await loginCookie(app);
    const id = await insertRunningSession();
    const abort = new AbortController();

    const res = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${id}/stream`, {
      headers: { cookie },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    abort.abort();

    await waitFor(() => {
      expect(fake.streamClosedCount).toBeGreaterThan(0);
    });
    await reader.cancel().catch(() => {});
    await app.close();
  });

  it('stream proxy ignores keep-alive-style comments before later frames', async () => {
    fake.streamWriteCommentBeforeSecondFrame = true;
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const id = await insertRunningSession();

    const streamed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/stream?after_event_id=52`,
      headers: { cookie },
    });

    expect(streamed.statusCode).toBe(200);
    expect(sseEventIds(streamed.body)).toEqual([53, 54]);
    expect(streamed.body).toContain('event: execution_summary');
    await app.close();
  });

  it('stream resume is lossless and duplicate-free across random disconnect boundaries', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const id = await insertRunningSession();
    const full = sseEventIds(
      (
        await app.inject({
          method: 'GET',
          url: `/api/sessions/${id}/stream?after_event_id=0`,
          headers: { cookie },
        })
      ).body,
    );
    const rng = new SeededPrng(0x55e);
    let lastDelivered = 0;
    const delivered: number[] = [];

    while (delivered.length < full.length) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}/stream?after_event_id=${lastDelivered}`,
        headers: { cookie },
      });
      const ids = sseEventIds(res.body);
      const take = Math.max(1, rng.int(ids.length + 1));
      for (const eventId of ids.slice(0, take)) {
        delivered.push(eventId);
        lastDelivered = eventId;
      }
    }

    expect(delivered).toEqual(full);
    await app.close();
  });

  it('GET /api/sessions/:id includes viewerCount excluding the spawner', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const bob = await loginUser(app, 'bob', 'Bob');
    const id = await insertRunningSession(alice.userId);
    await pool.query(
      `INSERT INTO session_views (session_id, user_id)
       VALUES ($1, $2), ($1, $2), ($1, $3)`,
      [id, alice.userId, bob.userId],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}`,
      headers: { cookie: alice.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().session.viewerCount).toBe(1);
    await app.close();
  });

  it('dogfood spectate metrics queries run against seeded session_views data', async () => {
    const bob = await pool.query<{ id: string }>(
      `INSERT INTO users (handle, display_name) VALUES ('bob', 'Bob') RETURNING id`,
    );
    const carol = await pool.query<{ id: string }>(
      `INSERT INTO users (handle, display_name) VALUES ('carol', 'Carol') RETURNING id`,
    );
    const sessions = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id
       )
       VALUES
         ($1, $2, 'thread-metrics-1', 'claude-code', 'metrics 1', 'completed', $3, $3),
         ($1, $2, 'thread-metrics-2', 'claude-code', 'metrics 2', 'completed', $3, $3),
         ($1, $2, 'thread-metrics-3', 'claude-code', 'metrics 3', 'completed', $3, $3)
       RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const [viewedBySpawnerAndBob, viewedByCarol] = sessions.rows;
    await pool.query(
      `INSERT INTO session_views (session_id, user_id)
       VALUES
         ($1, $3),
         ($1, $4),
         ($2, $5),
         ($2, $5)`,
      [viewedBySpawnerAndBob!.id, viewedByCarol!.id, fx.userId, bob.rows[0]!.id, carol.rows[0]!.id],
    );

    const pctViewed = await pool.query<{ pct: string }>(
      `SELECT round(100.0 * count(DISTINCT v.session_id) / NULLIF(count(DISTINCT s.id),0), 1) AS pct
       FROM sessions s LEFT JOIN session_views v
         ON v.session_id = s.id AND v.user_id <> s.spawned_by`,
    );
    expect(Number(pctViewed.rows[0]!.pct)).toBe(66.7);

    const distribution = await pool.query<{ viewer_count: number; count: number }>(
      `SELECT viewer_count, count(*) FROM (
         SELECT session_id, count(DISTINCT user_id) viewer_count
         FROM session_views GROUP BY 1) t GROUP BY 1 ORDER BY 1`,
    );
    expect(distribution.rows).toEqual([
      { viewer_count: 1, count: 1 },
      { viewer_count: 2, count: 1 },
    ]);
  });

  it('cancel marks the local session cancelled after calling Centaur session cancel', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, 'thread-cancel', 'claude-code', 'cancel me', 'running', $3, $3, 'exe_fake', 1)
       RETURNING id`,
      [fx.workspaceId, fx.channelId, fx.userId],
    );
    const id = inserted.rows[0]!.id;
    await setPendingQuestion(id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(202);
    expect(fake.requests.some((r) => r.path.endsWith('/release'))).toBe(false);
    expect(fake.requests.some((r) => r.path === '/api/session/thread-cancel/cancel')).toBe(true);
    const row = await pool.query('SELECT status, pending_question FROM sessions WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('cancelled');
    expect(row.rows[0].pending_question).toBeNull();
    const resolved = await pool.query('SELECT payload FROM events WHERE type = $1', [
      'session.question_resolved',
    ]);
    expect(resolved.rowCount).toBe(1);
    expect(resolved.rows[0].payload).toMatchObject({
      sessionId: id,
      questionId: 'q-main',
      reason: 'cancelled',
    });
    await app.close();
  });

  it('request -> grant moves driver, appends events, and transfers steer permission', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const bob = await loginUser(app, 'bob', 'Bob');
    const id = await insertRunningSession(alice.userId);

    const request = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/seat/request`,
      headers: { cookie: bob.cookie },
    });
    expect(request.statusCode).toBe(202);

    const grant = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/seat/grant`,
      headers: { cookie: alice.cookie },
      payload: { userId: bob.userId },
    });
    expect(grant.statusCode).toBe(202);

    const sessionRes = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}`,
      headers: { cookie: alice.cookie },
    });
    expect(sessionRes.json().session).toMatchObject({
      driverId: bob.userId,
      driver: { userId: bob.userId, displayName: 'Bob' },
      pendingSeatRequests: [],
    });

    const events = await pool.query('SELECT type, actor_id, payload FROM events ORDER BY id ASC');
    expect(events.rows.map((r) => r.type).filter((type) => type.startsWith('session.seat_'))).toEqual([
      'session.seat_requested',
      'session.seat_changed',
    ]);
    expect(events.rows.at(-2)?.payload).toMatchObject({ sessionId: id, by: bob.userId });
    expect(events.rows.at(-1)?.payload).toMatchObject({
      sessionId: id,
      from: alice.userId,
      to: bob.userId,
      reason: 'granted',
    });

    const oldDriverSteer = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/messages`,
      headers: { cookie: alice.cookie },
      payload: { text: 'old driver tries' },
    });
    expect(oldDriverSteer.statusCode).toBe(403);

    const newDriverSteer = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/messages`,
      headers: { cookie: bob.cookie },
      payload: { text: 'new driver steers' },
    });
    expect(newDriverSteer.statusCode).toBe(202);
    await app.close();
  });

  it('take refuses while driver watches, then succeeds with reason taken when absent', async () => {
    const hub = new WsHub();
    const app = await buildApp({
      pool,
      hub,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const bob = await loginUser(app, 'bob', 'Bob');
    const id = await insertRunningSession(alice.userId);

    const watching = hub.addClient(fakeSocket(), { id: alice.userId, handle: 'alice', displayName: 'Alice' });
    hub.subscribe(watching, [`session:${id}`]);

    const refused = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/seat/take`,
      headers: { cookie: bob.cookie },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('seat_held');

    hub.removeClient(watching);
    const taken = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/seat/take`,
      headers: { cookie: bob.cookie },
    });
    expect(taken.statusCode).toBe(202);

    const row = await pool.query('SELECT driver_id FROM sessions WHERE id = $1', [id]);
    expect(row.rows[0].driver_id).toBe(bob.userId);
    const event = await pool.query("SELECT payload FROM events WHERE type = 'session.seat_changed'");
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0].payload).toMatchObject({
      sessionId: id,
      from: alice.userId,
      to: bob.userId,
      reason: 'taken',
    });
    await app.close();
  });

  it('suggestion: a watcher proposes; only the driver may send it, posting a steer', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice'); // driver
    const bob = await loginUser(app, 'bob', 'Bob'); // spectator
    const id = await insertRunningSession(alice.userId);

    const create = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions`,
      headers: { cookie: bob.cookie },
      payload: { text: 'run the tests' },
    });
    expect(create.statusCode).toBe(202);

    const added = await pool.query(
      "SELECT actor_id, payload FROM events WHERE type = 'session.suggestion_added'",
    );
    expect(added.rows).toHaveLength(1);
    expect(added.rows[0].actor_id).toBe(bob.userId);
    const suggestionId = added.rows[0].payload.suggestionId as string;
    expect(added.rows[0].payload).toMatchObject({
      sessionId: id,
      authorId: bob.userId,
      text: 'run the tests',
    });

    // GET hydrates the queue with the author display name.
    const got = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}`,
      headers: { cookie: alice.cookie },
    });
    expect(got.json().session.suggestions).toEqual([
      expect.objectContaining({
        id: suggestionId,
        authorId: bob.userId,
        authorName: 'Bob',
        text: 'run the tests',
        status: 'pending',
      }),
    ]);

    // A non-driver may not resolve.
    const bobResolve = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions/${suggestionId}/resolve`,
      headers: { cookie: bob.cookie },
      payload: { action: 'send' },
    });
    expect(bobResolve.statusCode).toBe(403);

    // The driver sends an edited version → steer posted + row recorded + event.
    const send = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions/${suggestionId}/resolve`,
      headers: { cookie: alice.cookie },
      payload: { action: 'send', text: 'run the tests -v' },
    });
    expect(send.statusCode).toBe(202);

    const row = await pool.query(
      'SELECT status, resolved_by, sent_text FROM session_suggestions WHERE id = $1',
      [suggestionId],
    );
    expect(row.rows[0]).toMatchObject({
      status: 'sent',
      resolved_by: alice.userId,
      sent_text: 'run the tests -v',
    });

    const resolved = await pool.query(
      "SELECT actor_id, payload FROM events WHERE type = 'session.suggestion_resolved'",
    );
    expect(resolved.rows).toHaveLength(1);
    expect(resolved.rows[0].actor_id).toBe(alice.userId);
    expect(resolved.rows[0].payload).toMatchObject({
      sessionId: id,
      suggestionId,
      status: 'sent',
      sentText: 'run the tests -v',
    });

    // Resolving an already-resolved suggestion is a conflict.
    const again = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions/${suggestionId}/resolve`,
      headers: { cookie: alice.cookie },
      payload: { action: 'dismiss' },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it('suggestion: driver dismiss records the disposition + optional note and persists', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const bob = await loginUser(app, 'bob', 'Bob');
    const id = await insertRunningSession(alice.userId);

    await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions`,
      headers: { cookie: bob.cookie },
      payload: { text: 'maybe try X' },
    });
    const added = await pool.query(
      "SELECT payload FROM events WHERE type = 'session.suggestion_added'",
    );
    const suggestionId = added.rows[0].payload.suggestionId as string;

    const dismiss = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions/${suggestionId}/resolve`,
      headers: { cookie: alice.cookie },
      payload: { action: 'dismiss', note: 'not now' },
    });
    expect(dismiss.statusCode).toBe(202);

    // Dismissed rows persist (retro value), with the reason recorded.
    const row = await pool.query(
      'SELECT status, resolved_by, note FROM session_suggestions WHERE id = $1',
      [suggestionId],
    );
    expect(row.rows[0]).toMatchObject({
      status: 'dismissed',
      resolved_by: alice.userId,
      note: 'not now',
    });

    const got = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}`,
      headers: { cookie: alice.cookie },
    });
    expect(got.json().session.suggestions).toEqual([
      expect.objectContaining({ id: suggestionId, status: 'dismissed', note: 'not now' }),
    ]);
    await app.close();
  });

  it('suggestion: empty text is rejected', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const id = await insertRunningSession(alice.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions`,
      headers: { cookie: alice.cookie },
      payload: { text: '   ' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('suggestion: createSuggestion is idempotent by opId', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const id = await insertRunningSession(alice.userId);
    const opId = randomUUID();
    const post = () =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/suggestions`,
        headers: { cookie: alice.cookie },
        payload: { text: 'dedupe me', opId },
      });
    expect((await post()).statusCode).toBe(202);
    expect((await post()).statusCode).toBe(202);
    const rows = await pool.query('SELECT id FROM session_suggestions WHERE session_id = $1', [id]);
    expect(rows.rows).toHaveLength(1);
    const events = await pool.query(
      "SELECT id FROM events WHERE type = 'session.suggestion_added'",
    );
    expect(events.rows).toHaveLength(1);
    await app.close();
  });

  it('suggestion: resolve with a non-UUID suggestionId 404s instead of 500', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const id = await insertRunningSession(alice.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions/not-a-uuid/resolve`,
      headers: { cookie: alice.cookie },
      payload: { action: 'send' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('suggestion: rejected on a truly-ended (failed/cancelled) session', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const id = await insertSessionRow({ title: 'dead', status: 'failed' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions`,
      headers: { cookie: alice.cookie },
      payload: { text: 'too late' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('session_ended');
    await app.close();
  });

  it('answer proposal: a watcher proposes; the driver submits it (answers the question)', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const driverCookie = await loginCookie(app); // fx.userId is the driver
    const bob = await loginUser(app, 'bob', 'Bob'); // spectator
    const id = await insertSessionRow({ title: 'propose me', status: 'running' });
    await setPendingQuestion(id);

    const propose = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals`,
      headers: { cookie: bob.cookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });
    expect(propose.statusCode).toBe(202);

    const proposed = await pool.query(
      "SELECT actor_id, payload FROM events WHERE type = 'session.answer_proposed'",
    );
    expect(proposed.rows).toHaveLength(1);
    expect(proposed.rows[0].actor_id).toBe(bob.userId);
    const proposalId = proposed.rows[0].payload.proposalId as string;
    expect(proposed.rows[0].payload).toMatchObject({
      sessionId: id,
      questionId: 'q-main',
      authorId: bob.userId,
    });

    // GET hydrates the pending proposal with the author display name.
    const got = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}`,
      headers: { cookie: driverCookie },
    });
    expect(got.json().session.answerProposals).toEqual([
      expect.objectContaining({
        id: proposalId,
        questionId: 'q-main',
        authorId: bob.userId,
        authorName: 'Bob',
        status: 'pending',
      }),
    ]);

    // A non-driver may not resolve.
    const bobResolve = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals/${proposalId}/resolve`,
      headers: { cookie: bob.cookie },
      payload: { action: 'submit' },
    });
    expect(bobResolve.statusCode).toBe(403);

    // The driver submits → the question is answered (Centaur called, driver-attributed,
    // pending cleared) and the proposal is recorded.
    const submit = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals/${proposalId}/resolve`,
      headers: { cookie: driverCookie },
      payload: { action: 'submit' },
    });
    expect(submit.statusCode).toBe(202);

    expect(fake.answers).toHaveLength(1);
    expect(fake.answers[0]!.body).toEqual({
      question_id: 'q-main',
      answers: { choice: { answers: ['Fast'] } },
    });
    const sessRow = await pool.query('SELECT pending_question FROM sessions WHERE id = $1', [id]);
    expect(sessRow.rows[0].pending_question).toBeNull();
    const propRow = await pool.query(
      'SELECT status, resolved_by FROM session_answer_proposals WHERE id = $1',
      [proposalId],
    );
    expect(propRow.rows[0]).toMatchObject({ status: 'submitted', resolved_by: fx.userId });
    const answered = await pool.query(
      "SELECT actor_id FROM events WHERE type = 'session.question_answered'",
    );
    expect(answered.rows).toHaveLength(1);
    expect(answered.rows[0].actor_id).toBe(fx.userId);
    const resolved = await pool.query(
      "SELECT payload FROM events WHERE type = 'session.answer_proposal_resolved'",
    );
    expect(resolved.rows).toHaveLength(1);
    expect(resolved.rows[0].payload).toMatchObject({ proposalId, status: 'submitted' });

    const again = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals/${proposalId}/resolve`,
      headers: { cookie: driverCookie },
      payload: { action: 'dismiss' },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it('answer proposal submit clears a locally pending question when Centaur reports it is stale', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const driverCookie = await loginCookie(app);
    const bob = await loginUser(app, 'bob', 'Bob');
    const id = await insertSessionRow({ title: 'stale proposal', status: 'running' });
    await setPendingQuestion(id);

    const propose = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals`,
      headers: { cookie: bob.cookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });
    expect(propose.statusCode).toBe(202);
    const proposed = await pool.query(
      "SELECT payload FROM events WHERE type = 'session.answer_proposed'",
    );
    const proposalId = proposed.rows[0].payload.proposalId as string;
    fake.rejectNextAnswerQuestionNotPending();

    const submit = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals/${proposalId}/resolve`,
      headers: { cookie: driverCookie },
      payload: { action: 'submit' },
    });

    expect(submit.statusCode).toBe(409);
    expect(submit.json().error).toBe('question_not_pending');
    const sessRow = await pool.query('SELECT pending_question FROM sessions WHERE id = $1', [id]);
    expect(sessRow.rows[0].pending_question).toBeNull();
    const propRow = await pool.query('SELECT status FROM session_answer_proposals WHERE id = $1', [
      proposalId,
    ]);
    expect(propRow.rows[0].status).toBe('pending');
    const questionResolved = await pool.query(
      "SELECT payload FROM events WHERE type = 'session.question_resolved'",
    );
    expect(questionResolved.rows).toHaveLength(1);
    expect(questionResolved.rows[0].payload).toMatchObject({
      sessionId: id,
      questionId: 'q-main',
      reason: 'empty',
    });
    const answerEvents = await pool.query(
      "SELECT id FROM events WHERE type IN ('session.question_answered', 'session.answer_proposal_resolved')",
    );
    expect(answerEvents.rows).toHaveLength(0);
    await app.close();
  });

  it('answer proposal: the driver cannot propose (answers directly)', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const driverCookie = await loginCookie(app);
    const id = await insertSessionRow({ title: 'x', status: 'running' });
    await setPendingQuestion(id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals`,
      headers: { cookie: driverCookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('driver_answers_directly');
    await app.close();
  });

  it('answer proposal: driver dismiss records the disposition + note, leaves the question pending', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const driverCookie = await loginCookie(app);
    const bob = await loginUser(app, 'bob', 'Bob');
    const id = await insertSessionRow({ title: 'x', status: 'running' });
    await setPendingQuestion(id);
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals`,
      headers: { cookie: bob.cookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });
    const proposed = await pool.query(
      "SELECT payload FROM events WHERE type = 'session.answer_proposed'",
    );
    const proposalId = proposed.rows[0].payload.proposalId as string;

    const dismiss = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals/${proposalId}/resolve`,
      headers: { cookie: driverCookie },
      payload: { action: 'dismiss', note: 'wrong option' },
    });
    expect(dismiss.statusCode).toBe(202);
    const row = await pool.query(
      'SELECT status, resolved_by, note FROM session_answer_proposals WHERE id = $1',
      [proposalId],
    );
    expect(row.rows[0]).toMatchObject({ status: 'dismissed', resolved_by: fx.userId, note: 'wrong option' });
    // Dismiss doesn't answer the question — it stays pending and Centaur is untouched.
    const sess = await pool.query('SELECT pending_question FROM sessions WHERE id = $1', [id]);
    expect(sess.rows[0].pending_question).not.toBeNull();
    expect(fake.answers).toHaveLength(0);
    await app.close();
  });

  it('answer proposal: resolve with a non-UUID proposalId 404s', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const driverCookie = await loginCookie(app);
    const id = await insertSessionRow({ title: 'x', status: 'running' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals/not-a-uuid/resolve`,
      headers: { cookie: driverCookie },
      payload: { action: 'submit' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /api/sessions/:id/record aggregates transcript + overlay (suggestions, proposals, seat, questions)', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const driverCookie = await loginCookie(app); // fx.userId drives
    const bob = await loginUser(app, 'bob', 'Bob');
    const id = await insertSessionRow({ title: 'record me', status: 'running' });

    // Mirror a tiny transcript: a steer + a file edit + a shell op + an agent reply.
    await pool.query(
      `INSERT INTO session_events (session_id, centaur_event_id, event_kind, frame)
       VALUES ($1, 5, 'amp_raw_event', $2), ($1, 7, 'amp_raw_event', $4), ($1, 8, 'amp_raw_event', $5),
              ($1, 9, 'artifact.captured', $6), ($1, 10, 'amp_raw_event', $3)`,
      [
        id,
        JSON.stringify({
          event: 'amp_raw_event',
          event_id: 5,
          data: { type: 'item.completed', item: { type: 'userMessage', id: 'u1', text: 'do the thing' } },
        }),
        JSON.stringify({
          event: 'amp_raw_event',
          event_id: 10,
          data: { type: 'item.completed', item: { type: 'agentMessage', id: 'm1', text: 'done' } },
        }),
        JSON.stringify({
          event: 'amp_raw_event',
          event_id: 7,
          data: {
            type: 'assistant',
            uuid: 'a1',
            message: {
              id: 'am1',
              content: [
                {
                  type: 'tool_use',
                  id: 'edit-1',
                  name: 'Edit',
                  input: {
                    file_path: '/home/agent/workspace/src/app.ts',
                    old_string: 'const a = 1;',
                    new_string: 'const a = 2;',
                  },
                },
              ],
            },
          },
        }),
        JSON.stringify({
          event: 'amp_raw_event',
          event_id: 8,
          data: {
            type: 'assistant',
            uuid: 'a2',
            message: {
              id: 'am2',
              content: [
                {
                  type: 'tool_use',
                  id: 'bash-1',
                  name: 'Bash',
                  input: { command: 'npm install lodash' },
                },
              ],
            },
          },
        }),
        JSON.stringify({
          event: 'artifact.captured',
          event_id: 9,
          data: {
            type: 'artifact.captured',
            artifact_id: 'art-1',
            path: '/home/agent/workspace/out/chart.png',
            kind: 'created',
            mime: 'image/png',
            size_bytes: 4096,
            sha256: 'art-1-full',
            ref: 'blob-art-1',
          },
        }),
      ],
    );

    // A suggestion proposed by Bob, dismissed by the driver (persists).
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions`,
      headers: { cookie: bob.cookie },
      payload: { text: 'try X' },
    });
    const sug = await pool.query("SELECT payload FROM events WHERE type = 'session.suggestion_added'");
    const suggestionId = sug.rows[0].payload.suggestionId as string;
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/suggestions/${suggestionId}/resolve`,
      headers: { cookie: driverCookie },
      payload: { action: 'dismiss', note: 'not now' },
    });

    // A proposed answer, submitted by the driver (answers the question).
    await setPendingQuestion(id);
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals`,
      headers: { cookie: bob.cookie },
      payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } } },
    });
    const prop = await pool.query("SELECT payload FROM events WHERE type = 'session.answer_proposed'");
    const proposalId = prop.rows[0].payload.proposalId as string;
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/question-proposals/${proposalId}/resolve`,
      headers: { cookie: driverCookie },
      payload: { action: 'submit' },
    });

    // A seat handoff (granted to Bob).
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/seat/request`,
      headers: { cookie: bob.cookie },
    });
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/seat/grant`,
      headers: { cookie: driverCookie },
      payload: { userId: bob.userId },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/record`,
      headers: { cookie: driverCookie },
    });
    expect(res.statusCode).toBe(200);
    const record = res.json().record;

    // Transcript replayed from the mirror.
    expect(record.session.id).toBe(id);
    expect(record.transcript.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(record.transcript)).toContain('do the thing');

    // Work products: the file edit is derived into record.changes.
    expect(record.changes).toEqual([
      expect.objectContaining({ path: 'src/app.ts', kind: 'update', toolName: 'Edit' }),
    ]);

    // Work products: the shell op is classified into record.sideEffects.
    expect(record.sideEffects).toEqual([
      expect.objectContaining({ command: 'npm install lodash', category: 'package', risk: 'caution', toolName: 'Bash' }),
    ]);

    // Work products: the captured file is surfaced in record.artifacts (path stripped).
    expect(record.artifacts).toEqual([
      expect.objectContaining({ id: 'art-1', path: 'out/chart.png', kind: 'created', mime: 'image/png', ref: 'blob-art-1' }),
    ]);

    // Overlay: the dismissed suggestion (all statuses) with its rationale.
    expect(record.session.suggestions).toEqual([
      expect.objectContaining({ id: suggestionId, status: 'dismissed', note: 'not now', authorName: 'Bob' }),
    ]);

    // The submitted proposal appears (full list, not just pending).
    expect(record.answerProposals).toEqual([
      expect.objectContaining({ id: proposalId, status: 'submitted', authorName: 'Bob' }),
    ]);

    // Seat + question history.
    expect(record.seatHistory).toEqual([
      expect.objectContaining({ to: bob.userId, reason: 'granted' }),
    ]);
    expect(record.questionHistory.some((e: { kind: string }) => e.kind === 'answered')).toBe(true);

    // Participants resolve every referenced id to a display name.
    const participantIds = record.participants.map((p: { userId: string }) => p.userId);
    expect(participantIds).toContain(bob.userId);
    expect(participantIds).toContain(fx.userId);
    await app.close();
  });

  it('GET /api/sessions/:id/artifacts/by-path redirects to durable CAS without Centaur fallback', async () => {
    const s3 = fakeArtifactStorage();
    const app = await buildApp({
      pool,
      sessionRuns: {
        baseUrl: fake.url,
        apiKey: 'session-key',
        artifactStorage: s3.storage,
        autoResume: false,
      },
    });
    await app.ready();
    const cookie = await loginCookie(app);
    const id = await insertSessionRow({ title: 'serve cas', status: 'running' });
    const { s3Key } = await commitDurableArtifact({
      sessionId: id,
      path: 'out/chart.png',
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mime: 'image/png',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/artifacts/by-path?path=${encodeURIComponent('out/chart.png')}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `https://storage.local/get/${encodeURIComponent(s3Key)}?inline=1`,
    );
    expect(s3.presignCalls).toEqual([
      { key: s3Key, filename: 'chart.png', inline: true },
    ]);
    expect(fake.requests.some((r) => r.path.includes('/artifacts/'))).toBe(false);
    await app.close();
  });

  it('a non-member gets 404 for a DM session artifact (existence not leaked)', async () => {
    const s3 = fakeArtifactStorage();
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', artifactStorage: s3.storage, autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const bob = await loginUser(app, 'bob', 'Bob');
    const cara = await loginUser(app, 'cara', 'Cara');
    const { channel } = await getOrCreateDm(pool, {
      workspaceId: fx.workspaceId,
      userIdA: alice.userId,
      userIdB: bob.userId,
    });
    const id = await insertSessionRow({
      channelId: channel.id,
      title: 'dm artifacts',
      status: 'running',
      spawnedBy: alice.userId,
    });
    await commitDurableArtifact({
      sessionId: id,
      path: 'out/chart.png',
      body: Buffer.from([1, 2, 3]),
      mime: 'image/png',
    });

    const member = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/artifacts/by-path?path=${encodeURIComponent('out/chart.png')}`,
      headers: { cookie: alice.cookie },
    });
    expect(member.statusCode).toBe(302);

    const outsider = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/artifacts/by-path?path=${encodeURIComponent('out/chart.png')}`,
      headers: { cookie: cara.cookie },
    });
    // 404, not 403 — a guessed session id in a DM must not leak existence,
    // and must never reach Centaur.
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json().error).toBe('session_not_found');
    await app.close();
  });

  it('concurrent seat mutations produce exactly one winner and one seat_changed event', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const bob = await loginUser(app, 'bob', 'Bob');
    const carol = await loginUser(app, 'carol', 'Carol');
    const id = await insertRunningSession(alice.userId);

    await pool.query(`
      CREATE OR REPLACE FUNCTION test_slow_driver_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
          PERFORM pg_sleep(0.2);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS test_slow_driver_update ON sessions;
      CREATE TRIGGER test_slow_driver_update
        BEFORE UPDATE OF driver_id ON sessions
        FOR EACH ROW EXECUTE FUNCTION test_slow_driver_update();
    `);
    try {
      const [a, b] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/sessions/${id}/seat/take`,
          headers: { cookie: bob.cookie },
        }),
        app.inject({
          method: 'POST',
          url: `/api/sessions/${id}/seat/take`,
          headers: { cookie: carol.cookie },
        }),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([202, 409]);
      const events = await pool.query("SELECT payload FROM events WHERE type = 'session.seat_changed'");
      expect(events.rows).toHaveLength(1);
      expect([bob.userId, carol.userId]).toContain(events.rows[0].payload.to);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_slow_driver_update ON sessions');
      await pool.query('DROP FUNCTION IF EXISTS test_slow_driver_update()');
      await app.close();
    }
  });

  it("allows cancel by driver who is not spawner and rejects a random third user", async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const bob = await loginUser(app, 'bob', 'Bob');
    const carol = await loginUser(app, 'carol', 'Carol');
    const id = await insertRunningSession(bob.userId);

    const third = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/cancel`,
      headers: { cookie: carol.cookie },
    });
    expect(third.statusCode).toBe(403);

    const driverCancel = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/cancel`,
      headers: { cookie: bob.cookie },
    });
    expect(driverCancel.statusCode).toBe(202);
    expect(fake.requests.some((r) => r.path.endsWith('/release'))).toBe(false);
    expect(fake.requests.some((r) => r.path.endsWith('/cancel'))).toBe(true);
    await app.close();
  });
});

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sseEventIds(body: string): number[] {
  const ids: number[] = [];
  for (const part of body.split(/\r?\n\r?\n/)) {
    const data = part
      .split(/\r?\n/)
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    if (!data) continue;
    const parsed = JSON.parse(data) as { event_id?: unknown };
    if (typeof parsed.event_id === 'number') ids.push(parsed.event_id);
  }
  return ids;
}

function sendJson(res: ServerResponse, body: object, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('session access control', () => {
  it('GET /api/sessions filters DM sessions by channel access', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const bob = await loginUser(app, 'bob', 'Bob');
    const cara = await loginUser(app, 'cara', 'Cara');
    const { channel } = await getOrCreateDm(pool, {
      workspaceId: fx.workspaceId,
      userIdA: alice.userId,
      userIdB: bob.userId,
    });
    const publicId = await insertSessionRow({
      title: 'public session',
      status: 'running',
      spawnedBy: alice.userId,
    });
    const dmId = await insertSessionRow({
      channelId: channel.id,
      title: 'dm session',
      status: 'running',
      spawnedBy: alice.userId,
    });

    const asBob = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: bob.cookie },
    });
    const asCara = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: cara.cookie },
    });
    expect(asBob.statusCode).toBe(200);
    expect(asCara.statusCode).toBe(200);
    expect(asBob.json().sessions.map((s: { id: string }) => s.id)).toEqual(
      expect.arrayContaining([publicId, dmId]),
    );
    expect(asCara.json().sessions.map((s: { id: string }) => s.id)).toContain(publicId);
    expect(asCara.json().sessions.map((s: { id: string }) => s.id)).not.toContain(dmId);
    await app.close();
  });

  it('GET /api/sessions supports status filters, ordering, limit cap, and light shape', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const completedOld = await insertSessionRow({
      title: 'completed old',
      status: 'completed',
      spawnedBy: alice.userId,
      createdAt: '2025-01-01T00:00:00.000Z',
      completedAt: '2025-01-01T00:10:00.000Z',
      costUsd: 1.25,
    });
    const runningOlder = await insertSessionRow({
      title: 'running older',
      status: 'running',
      spawnedBy: alice.userId,
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    const queuedNewer = await insertSessionRow({
      title: 'queued newer',
      status: 'queued',
      spawnedBy: alice.userId,
      createdAt: '2025-01-03T00:00:00.000Z',
    });
    const failedNewest = await insertSessionRow({
      title: 'failed newest',
      status: 'failed',
      spawnedBy: alice.userId,
      createdAt: '2025-01-04T00:00:00.000Z',
      completedAt: '2025-01-04T00:01:00.000Z',
    });

    const all = await app.inject({
      method: 'GET',
      url: '/api/sessions?limit=500',
      headers: { cookie: alice.cookie },
    });
    expect(all.statusCode).toBe(200);
    const allSessions = all.json().sessions;
    expect(allSessions.map((s: { id: string }) => s.id)).toEqual([
      queuedNewer,
      runningOlder,
      failedNewest,
      completedOld,
    ]);
    expect(Object.keys(allSessions[0]).sort()).toEqual([
      'channelId',
      'channelName',
      'completedAt',
      'costUsd',
      'createdAt',
      'harness',
      'id',
      'spawnedBy',
      'spawnerName',
      'status',
      'title',
    ]);
    expect(allSessions[3]).toMatchObject({
      id: completedOld,
      channelId: fx.channelId,
      channelName: 'general',
      title: 'completed old',
      status: 'completed',
      harness: 'claude-code',
      spawnedBy: alice.userId,
      spawnerName: 'Alice',
      costUsd: 1.25,
      createdAt: '2025-01-01T00:00:00.000Z',
      completedAt: '2025-01-01T00:10:00.000Z',
    });

    const running = await app.inject({
      method: 'GET',
      url: '/api/sessions?status=running',
      headers: { cookie: alice.cookie },
    });
    expect(running.json().sessions.map((s: { id: string }) => s.id)).toEqual([
      queuedNewer,
      runningOlder,
    ]);

    const recent = await app.inject({
      method: 'GET',
      url: '/api/sessions?status=recent&limit=1',
      headers: { cookie: alice.cookie },
    });
    expect(recent.json().sessions.map((s: { id: string }) => s.id)).toEqual([failedNewest]);
    await app.close();
  });

  it('sessions in a DM are 404 for non-members, visible to members', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const bob = await loginUser(app, 'bob', 'Bob');
    const cara = await loginUser(app, 'cara', 'Cara');

    const { channel } = await getOrCreateDm(pool, {
      workspaceId: fx.workspaceId,
      userIdA: alice.userId,
      userIdB: bob.userId,
    });
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, $3, 'claude-code', 'dm session', 'running', $4, $4, 'exe_fake', 1)
       RETURNING id`,
      [fx.workspaceId, channel.id, `thread-${randomUUID()}`, alice.userId],
    );
    const sessionId = inserted.rows[0]!.id;

    const asUser = (cookie: string) =>
      app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: { cookie } });
    expect((await asUser(alice.cookie)).statusCode).toBe(200);
    expect((await asUser(bob.cookie)).statusCode).toBe(200);
    // 404, not 403 — existence of someone else's DM session must not leak.
    expect((await asUser(cara.cookie)).statusCode).toBe(404);

    const stream = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/stream`,
      headers: { cookie: cara.cookie },
    });
    expect(stream.statusCode).toBe(404);
    await app.close();
  });
});

describe('session list access control', () => {
  it('hides private-channel sessions from non-members in GET /api/sessions', async () => {
    const app = await buildApp({
      pool,
      sessionRuns: { baseUrl: fake.url, apiKey: 'test', autoResume: false },
    });
    await app.ready();
    const alice = await loginUser(app, 'alice', 'Alice');
    const cara = await loginUser(app, 'cara', 'Cara');

    const priv = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'secret-room',
      actorId: alice.userId,
      private: true,
    });
    await pool.query(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, $3, 'claude-code', 'private work', 'running', $4, $4, 'exe_fake', 1)`,
      [fx.workspaceId, priv.channel.id, `thread-${randomUUID()}`, alice.userId],
    );

    const asUser = (cookie: string) =>
      app.inject({ method: 'GET', url: '/api/sessions?status=all', headers: { cookie } });
    const aliceList = (await asUser(alice.cookie)).json().sessions as { title: string }[];
    expect(aliceList.some((s) => s.title === 'private work')).toBe(true);
    const caraList = (await asUser(cara.cookie)).json().sessions as { title: string }[];
    expect(caraList.some((s) => s.title === 'private work')).toBe(false);
    await app.close();
  });
});

function fakeIronControl(
  calls: Array<{ url: string; init: RequestInit }>,
  options: { inaccessibleGitHubRepos?: string[] } = {},
): IronControlAdminClient {
  return new IronControlAdminClient({
    baseUrl: 'http://iron.test',
    apiKey: 'iak_test',
    fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const path = new URL(String(url)).pathname;
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/effective_config')) {
        return json({
          data: {
            secrets: [{ replace: { proxy_value: 'GITHUB_TOKEN' }, rules: [{ host: 'api.github.com' }] }],
          },
        });
      }
      if (path.endsWith('/validate_github_repos')) {
        return json({ data: { inaccessible: options.inaccessibleGitHubRepos ?? [] } });
      }
      if (path.includes('/roles/')) {
        return json({ data: { id: 'role_github_default', namespace: 'default', foreign_id: 'github-default' } });
      }
      if (path.includes('/principals/')) {
        return json({ data: { id: 'prn_atrium', namespace: 'default', foreign_id: 'atrium-principal' } });
      }
      return json({ data: { ok: true } });
    }) as typeof fetch,
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
