// Harness-transcript internal endpoints (x-api-key): auth + validation, plus a
// real PUT-to-GET round-trip against PG + object storage (the daemon's
// capture/restore contract for the rollout-JSONL resume project).
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

const mockedS3 = vi.hoisted(() => {
  class FakeStorage {
    readonly objects = new Map<string, { body: Buffer; contentType: string }>();

    reset(): void {
      this.objects.clear();
    }

    uploadObject = async (key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> => {
      this.objects.set(key, { body: Buffer.from(body), contentType });
    };

    getObjectBytes = async (key: string): Promise<Buffer> => {
      const object = this.objects.get(key);
      if (!object) throw new Error(`missing object: ${key}`);
      return Buffer.from(object.body);
    };
  }

  return { storage: new FakeStorage() };
});

vi.mock('../src/s3.js', () => ({
  copyObject: async () => {},
  deleteObject: async () => {},
  downloadObject: async () => {},
  ensureBucket: async () => {},
  getObjectBytes: mockedS3.storage.getObjectBytes,
  headObject: async () => null,
  presignGet: async () => 'https://storage.local/get',
  presignPut: async () => 'https://storage.local/put',
  uploadObject: mockedS3.storage.uploadObject,
  uploadObjectStream: async () => {},
}));

const KEY = 'harness-transcript-test-key';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  mockedS3.storage.reset();
  await pool.query('TRUNCATE harness_transcripts CASCADE');
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    artifactCaptureApiKey: KEY,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

async function session(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1,$2,$3,'ht','running',$4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  expect(res.statusCode).toBe(200);
  return res.headers['set-cookie'] as string;
}

describe('harness-transcript internal endpoints', () => {
  it('requires the api key for PUT and GET', async () => {
    const sid = await session();
    const get = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/harness-transcript?harness=claude`,
    });
    expect(get.statusCode).toBe(401);
    const put = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/harness-transcript?harness=claude`,
      headers: { 'content-type': 'application/x-ndjson' },
      payload: '{}',
    });
    expect(put.statusCode).toBe(401);
  });

  it('rejects an unknown harness (400)', async () => {
    const sid = await session();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/harness-transcript?harness=amp`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT to an unknown session is 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${randomUUID()}/harness-transcript?harness=codex`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/x-ndjson' },
      payload: '{"a":1}\n',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET is 404 before any capture', async () => {
    const sid = await session();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/harness-transcript?harness=claude`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it('captures a transcript and serves it back byte-for-byte (last-write-wins)', async () => {
    const sid = await session();
    const body1 = '{"type":"user","text":"remember 42"}\n';
    const put1 = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/harness-transcript?harness=claude`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/x-ndjson' },
      payload: body1,
    });
    expect(put1.statusCode).toBe(200);
    expect(put1.json().size_bytes).toBe(Buffer.byteLength(body1));

    const get1 = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/harness-transcript?harness=claude`,
      headers: { 'x-api-key': KEY },
    });
    expect(get1.statusCode).toBe(200);
    expect(get1.body).toBe(body1);
    expect(get1.headers['x-transcript-sha256']).toBe(put1.json().sha256);

    // Second capture overwrites (full-snapshot, last-write-wins).
    const body2 = body1 + '{"type":"assistant","text":"ok, 42"}\n';
    await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/harness-transcript?harness=claude`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/x-ndjson' },
      payload: body2,
    });
    const get2 = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/harness-transcript?harness=claude`,
      headers: { 'x-api-key': KEY },
    });
    expect(get2.body).toBe(body2);

    // Per-harness isolation: codex wasn't captured for this session.
    const codex = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/harness-transcript?harness=codex`,
      headers: { 'x-api-key': KEY },
    });
    expect(codex.statusCode).toBe(404);
  });

  it('stores a redacted capability snapshot and re-derives it for viewer access', async () => {
    const sid = await session();
    const body = `${JSON.stringify({
      type: 'attachment',
      timestamp: '2026-07-03T00:00:00.000Z',
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: ['Read', 'mcp__deepwiki__ask_question'],
        removedNames: [],
        readdedNames: [],
        pendingMcpServers: ['RepoPrompt'],
      },
    })}\n`;

    const put = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/harness-transcript?harness=claude`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/x-ndjson' },
      payload: body,
    });
    expect(put.statusCode).toBe(200);

    const stored = await pool.query<{ source_sha256: string; snapshot_json: { counts: { tools: number } } }>(
      `SELECT source_sha256, snapshot_json
         FROM session_capability_snapshots
        WHERE session_id = $1 AND harness = 'claude'`,
      [sid],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.source_sha256).toBe(put.json().sha256);
    expect(stored.rows[0]!.snapshot_json.counts.tools).toBe(2);

    await pool.query(`DELETE FROM session_capability_snapshots WHERE session_id = $1`, [sid]);
    const cookie = await login();
    const capabilities = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/atrium/capabilities`,
      headers: { cookie },
    });
    expect(capabilities.statusCode).toBe(200);
    const bodyJson = capabilities.json<{
      snapshots: { harness: string; tools: { name: string }[]; pendingMcpServers: string[] }[];
    }>();
    expect(bodyJson.snapshots).toHaveLength(1);
    expect(bodyJson.snapshots[0]!.harness).toBe('claude');
    expect(bodyJson.snapshots[0]!.tools.map((tool) => tool.name)).toEqual(['mcp__deepwiki__ask_question', 'Read']);
    expect(bodyJson.snapshots[0]!.pendingMcpServers).toEqual(['RepoPrompt']);

    const regenerated = await pool.query(`SELECT 1 FROM session_capability_snapshots WHERE session_id = $1`, [sid]);
    expect(regenerated.rowCount).toBe(1);
  });
});
