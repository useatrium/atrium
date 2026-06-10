import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
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
  readonly requests: RecordedRequest[] = [];
  url = '';

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<void> {
    const fixture = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'centaur-client', 'test', 'fixtures', 'A_pong.json'),
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJson(req);
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, body, query: url.searchParams });

    if (req.method === 'POST' && url.pathname === '/agent/spawn') {
      return sendJson(res, { thread_key: body.thread_key, assignment_generation: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/agent/message') {
      return sendJson(res, {});
    }
    if (req.method === 'POST' && url.pathname === '/agent/execute') {
      return sendJson(res, { execution_id: 'exe_fake' });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/release')) {
      return sendJson(res, {});
    }
    if (req.method === 'GET' && /\/agent\/threads\/[^/]+\/events/.test(url.pathname)) {
      const after = Number(url.searchParams.get('after_event_id') ?? 0);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of this.frames.filter((f) => f.event_id > after)) {
        res.write(`id: ${frame.event_id}\n`);
        res.write(`event: ${frame.event}\n`);
        res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
      }
      res.end();
      return;
    }

    res.writeHead(404);
    res.end('not found');
  }
}

let pool: pg.Pool;
let fx: Fixture;
let fake: FakeCentaur;

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
});

async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  return login.headers['set-cookie'] as string;
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
    await app.close();
  });

  it('cancel calls release with cancel_inflight and marks the session cancelled', async () => {
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

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(202);
    const release = fake.requests.find((r) => r.path.endsWith('/release'));
    expect(release?.body).toMatchObject({ release_id: `rel-${id}`, cancel_inflight: true });
    const row = await pool.query('SELECT status FROM sessions WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('cancelled');
    await app.close();
  });
});

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, body: object): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
