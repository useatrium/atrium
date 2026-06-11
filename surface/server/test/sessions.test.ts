import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { createChannel, getOrCreateDm } from '../src/events.js';
import { WsHub, type HubSocket } from '../src/hub.js';
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

  clearFrames(): void {
    this.frames = [];
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
  return { cookie: login.headers['set-cookie'] as string, userId: login.json().user.id };
}

async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  return (await loginUser(app, 'alice', 'Alice')).cookie;
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
        const release = fake.requests.find((r) => r.path.endsWith('/release'));
        expect(release?.body).toMatchObject({ cancel_inflight: false });
        expect(release?.body.release_id).toContain(`rel-${id}-`);
        const row = await pool.query('SELECT assignment_generation FROM sessions WHERE id = $1', [id]);
        expect(row.rows[0].assignment_generation).toBeNull();
      });
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
    const release = fake.requests.find((r) => r.path.endsWith('/release'));
    expect(release?.body).toMatchObject({ release_id: `rel-${id}`, cancel_inflight: true });
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
