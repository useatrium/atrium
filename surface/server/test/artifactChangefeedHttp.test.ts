// HTTP surface for the change-feed: auth gating, cursor parsing, response shape.
// The gap-free semantics themselves are covered at the ledger level in
// artifactChangefeed.test.ts; this exercises the route wrapper end-to-end.
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
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
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

function commit(sessionId: string, path: string, sha: string, kind: 'created' | 'modified') {
  return ledger.commitVersion({
    sessionId,
    channelId: fx.channelId,
    path,
    blobSha: sha,
    sizeBytes: 10,
    mime: 'text/markdown',
    author: `agent:${sessionId}`,
    kind,
  });
}

describe('GET /api/sessions/:id/artifacts/changes', () => {
  it('returns rows + a resumable cursor for an accessible session', async () => {
    const cookie = await loginCookie();
    const sid = await insertSession();
    await commit(sid, 'a.md', 'a'.repeat(64), 'created');
    await commit(sid, 'a.md', 'b'.repeat(64), 'modified');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/changes`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ path: string; seq: number }>; next_cursor: string };
    expect(body.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(body.next_cursor).toMatch(/^\d+\.\d+$/);

    // Resume with the returned cursor — nothing new.
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/changes?since=${body.next_cursor}`,
      headers: { cookie },
    });
    expect(res2.json().rows).toHaveLength(0);
  });

  it('rejects a malformed cursor with 400', async () => {
    const cookie = await loginCookie();
    const sid = await insertSession();
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/changes?since=not-a-cursor`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an unauthenticated caller', async () => {
    const sid = await insertSession();
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/changes`,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
