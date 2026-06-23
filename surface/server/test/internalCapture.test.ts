// Internal node-ingestion endpoints (x-api-key): auth gating + a real
// capture→changes→raw round-trip against PG + MinIO (the node daemon's contract).
// Run with ARTIFACT_CAPTURE_API_KEY set (config reads it at import).
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ensureBucket } from '../src/s3.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

const KEY = process.env.ARTIFACT_CAPTURE_API_KEY ?? '';
const haveKey = KEY.length > 0;

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  pool = await createTestPool();
  try {
    await ensureBucket();
  } catch {
    /* MinIO may be down; happy-path tests guard on that */
  }
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({ pool, sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false } });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

async function session(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1,$2,$3,'int','running',$4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

describe('internal node-ingestion auth', () => {
  it('rejects capture/raw/changes without the api key', async () => {
    const sid = await session();
    for (const url of [
      `/api/internal/sessions/${sid}/artifacts/changes`,
      `/api/internal/sessions/${sid}/artifacts/raw?path=a.md`,
      `/api/internal/sessions/${sid}/hydration-scope`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
    const cap = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture?path=a.md`,
      headers: { 'content-type': 'text/markdown' },
      payload: 'x',
    });
    expect(cap.statusCode).toBe(401);
  });

  it('rejects a wrong api key', async () => {
    const sid = await session();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/changes`,
      headers: { 'x-api-key': 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe.runIf(haveKey)('internal capture round-trip (PG + MinIO)', () => {
  it('captures a version, surfaces it in the feed, and serves it back raw', async () => {
    const sid = await session();
    const cap = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture?path=shared/a.md`,
      headers: { 'x-api-key': KEY, 'content-type': 'text/markdown' },
      payload: 'node captured this',
    });
    expect(cap.statusCode).toBe(200);
    expect(cap.json()).toMatchObject({ seq: 1, status: 'normal' });

    const feed = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/changes`,
      headers: { 'x-api-key': KEY },
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.json().rows.map((r: { path: string }) => r.path)).toContain('shared/a.md');

    const raw = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/raw?path=shared/a.md`,
      headers: { 'x-api-key': KEY },
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe('node captured this');
  });

  it('raw 404s for an unknown path', async () => {
    const sid = await session();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/raw?path=missing.md`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it('hydration-scope returns the subscription set (own scratch + shared)', async () => {
    const sid = await session();
    for (const path of ['shared/note.md', `scratch/${sid}/local.md`]) {
      const cap = await app.inject({
        method: 'POST',
        url: `/api/internal/sessions/${sid}/artifacts/capture?path=${encodeURIComponent(path)}`,
        headers: { 'x-api-key': KEY, 'content-type': 'text/markdown' },
        payload: 'x',
      });
      expect(cap.statusCode).toBe(200);
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/hydration-scope`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json().paths as Array<{ path: string; sha: string | null }>;
    const paths = entries.map((p) => p.path);
    expect(paths).toContain('shared/note.md');
    expect(paths).toContain(`scratch/${sid}/local.md`);
    // the node needs the blob sha to CAS-key the lower (5B-3 materialize_cached)
    expect(entries.find((e) => e.path === 'shared/note.md')?.sha).toMatch(/^[0-9a-f]{64}$/);
  });
});
