// HTTP surface for the conflict + scope endpoints: auth gating and the PG-only
// branches (scope listing, no-conflict 404/409, unknown-artifact 404). Byte-level
// conflict assembly + resolution are covered in artifactConflict.test.ts.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger } from '../src/artifact-ledger.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

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
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

async function loginCookie(): Promise<string> {
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { handle: 'alice', displayName: 'Alice' } });
  await addWorkspaceMember(pool, fx.workspaceId, login.json().user.id);
  return login.headers['set-cookie'] as string;
}

async function insertSession(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id)
     VALUES ($1, $2, $3, 'claude-code', 'cf', 'running', $4, $4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `thread-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

function commit(sid: string, path: string, sha: string | null, kind: 'created' | 'modified' | 'deleted') {
  return ledger.commitVersion({
    sessionId: sid,
    channelId: fx.channelId,
    path,
    blobSha: sha,
    sizeBytes: 10,
    mime: 'text/markdown',
    author: `agent:${sid}`,
    kind,
  });
}

describe('GET /api/sessions/:id/hydration-scope', () => {
  it('lists subscribed paths for an accessible session', async () => {
    const cookie = await loginCookie();
    const sid = await insertSession();
    await commit(sid, 'a.md', 'a'.repeat(64), 'created');
    await commit(sid, 'b.md', 'b'.repeat(64), 'created');
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sid}/hydration-scope`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scope: string; paths: Array<{ path: string }> };
    expect(body.scope).toBe('session');
    expect(body.paths.map((p) => p.path)).toEqual(['a.md', 'b.md']);
  });

  it('refuses an unauthenticated caller', async () => {
    const sid = await insertSession();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sid}/hydration-scope` });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe('GET /api/sessions/:id/artifacts/conflict', () => {
  it('404s when the path has no unresolved conflict', async () => {
    const cookie = await loginCookie();
    const sid = await insertSession();
    await commit(sid, 'a.md', 'a'.repeat(64), 'created');
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/conflict?path=a.md`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s without a path', async () => {
    const cookie = await loginCookie();
    const sid = await insertSession();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sid}/artifacts/conflict`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/sessions/:id/artifacts/:artifactId/resolve', () => {
  it('404s for an unknown artifact', async () => {
    const cookie = await loginCookie();
    const sid = await insertSession();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sid}/artifacts/${randomUUID()}/resolve`,
      headers: { cookie, 'content-type': 'text/markdown' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(404);
  });

  it('409s when the artifact has no unresolved conflict', async () => {
    const cookie = await loginCookie();
    const sid = await insertSession();
    await commit(sid, 'a.md', 'a'.repeat(64), 'created');
    const artifactId = (await ledger.artifactIdByPath(sid, 'a.md'))!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sid}/artifacts/${artifactId}/resolve`,
      headers: { cookie, 'content-type': 'text/markdown' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(409);
  });
});
