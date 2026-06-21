import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { casBlobKey } from '../src/artifact-ledger.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

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
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id)
     VALUES ($1, $2, $3, 'claude-code', 'files-route', 'running', $4, $4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `thread-${randomUUID()}`, fx.userId],
  );
  return res.rows[0]!.id;
}

async function seedOffloadedBlob(bytes: Buffer, mime: string): Promise<void> {
  const sha = createHash('sha256').update(bytes).digest('hex');
  await pool.query(
    `INSERT INTO cas_blobs (sha256, size_bytes, mime, s3_key)
     VALUES ($1, $2, $3, $4)`,
    [sha, bytes.byteLength, mime, casBlobKey(sha)],
  );
}

describe('PUT /api/sessions/:id/files', () => {
  it('rejects git-backed repo files as read-only', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/files?path=repo/src/app.ts`,
      headers: { cookie, 'content-type': 'text/plain' },
      payload: 'change',
    });

    expect(res.statusCode).toBe(405);
    expect(res.json()).toEqual({
      error: 'repo_read_only',
      message: 'repo files are read-only in-app; steer the agent to change code',
    });
  });

  it('keeps ledger file write-back working', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();
    const payload = Buffer.from('ledger change\n');
    await seedOffloadedBlob(payload, 'text/markdown');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/files?path=notes/plan.md`,
      headers: { cookie, 'content-type': 'text/markdown' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ backing: 'ledger', seq: 1 });
  });
});
