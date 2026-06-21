import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CentaurClient } from '@atrium/centaur-client';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger } from '../src/artifact-ledger.js';
import { ensureBucket } from '../src/s3.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

const KEY = process.env.ARTIFACT_CAPTURE_API_KEY ?? '';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
let ledger: ArtifactLedger;

beforeAll(async () => {
  pool = await createTestPool();
  ledger = new ArtifactLedger(pool);
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
  app = await buildApp({
    pool,
    sessionRuns: {
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'test',
      autoResume: false,
      centaur: new CentaurClient({
        baseUrl: 'http://centaur.test',
        apiKey: 'test',
        fetchImpl: async () => new Response('node captured this', {
          headers: { 'content-type': 'text/markdown', 'content-length': '18' },
        }),
      }),
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function loginCookie(): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  await addWorkspaceMember(pool, fx.workspaceId, login.json().user.id);
  return login.headers['set-cookie'] as string;
}

async function session(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id, current_execution_id)
     VALUES ($1, $2, $3, 'claude-code', 'acl-route-test', 'running', $4, $4, 'exec-1') RETURNING id`,
    [fx.workspaceId, fx.channelId, `thread-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

async function commit(sessionId: string, path: string, bytes: string) {
  const payload = Buffer.from(bytes);
  const sha = createHash('sha256').update(payload).digest('hex');
  await pool.query(
    `INSERT INTO cas_blobs (sha256, size_bytes, mime)
     VALUES ($1, $2, 'text/markdown')
     ON CONFLICT (sha256) DO NOTHING`,
    [sha, payload.byteLength],
  );
  await pool.query(
    `INSERT INTO session_artifacts (id, session_id, execution_id, centaur_ref, path, mime, size_bytes, sha256)
     VALUES ($1, $2, 'exec-1', $3, $4, 'text/markdown', $5, $6)`,
    [`artifact-${sha.slice(0, 12)}`, sessionId, `ref-${sha.slice(0, 12)}`, path, payload.byteLength, sha],
  );
  await ledger.commitVersion({
    sessionId,
    channelId: fx.channelId,
    path,
    blobSha: sha,
    sizeBytes: payload.byteLength,
    mime: 'text/markdown',
    author: `agent:${sessionId}`,
    kind: 'created',
  });
}

describe('artifact scope route enforcement', () => {
  it('404s a user read of a scratch artifact', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commit(sid, 'scratch/secret.md', 'private notes');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/by-path?path=${encodeURIComponent('scratch/secret.md')}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'artifact_not_found', message: 'artifact not found' });
  });

  it('allows a user read of a shared artifact and exposes its scope', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commit(sid, 'shared/report.md', 'shared report body');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/by-path?path=${encodeURIComponent('shared/report.md')}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-artifact-scope']).toBe('workspace');
    expect(res.body).toBe('node captured this');
  });

  it('omits private artifacts from the user-facing files listing', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commit(sid, 'scratch/secret.md', 'private notes');
    await commit(sid, 'shared/report.md', 'shared report body');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/files?dir=`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ path: string; scope?: string }> };
    expect(body.rows.map((row) => row.path)).toEqual(['shared']);
    expect(body.rows[0]?.scope).toBe('workspace');
  });

  it.runIf(KEY.length > 0)('keeps the internal raw path able to read a scratch artifact', async () => {
    await ensureBucket();
    const sid = await session();
    const cap = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture?path=${encodeURIComponent('scratch/secret.md')}`,
      headers: { 'x-api-key': KEY, 'content-type': 'text/markdown' },
      payload: 'private notes',
    });
    expect(cap.statusCode).toBe(200);

    const raw = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/raw?path=${encodeURIComponent('scratch/secret.md')}`,
      headers: { 'x-api-key': KEY },
    });

    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe('private notes');
  });
});
