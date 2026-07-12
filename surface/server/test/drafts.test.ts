import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { pruneDraftTombstones } from '../src/drafts.js';
import { createTestPool, seedFixture, truncateAll } from './helpers.js';

let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  await seedFixture(pool);
  app = await buildApp({
    pool,
    rateLimit: false,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string, user: res.json().user };
}

async function putDraft(cookie: string, draftKey: string, text: string, opId?: string) {
  return app.inject({
    method: 'PUT',
    url: `/api/me/drafts/${encodeURIComponent(draftKey)}`,
    headers: { cookie },
    payload: { text, ...(opId ? { opId } : {}) },
  });
}

async function sync(cookie: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/sync?after=0&limit=100',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('user drafts', () => {
  it('upserts drafts and ships them in the sync snapshot', async () => {
    const { cookie } = await login();
    const saved = await putDraft(cookie, 'channel:one', 'hello');
    expect(saved.statusCode).toBe(200);

    const body = await sync(cookie);
    expect(body.state.drafts['channel:one']).toMatchObject({ text: 'hello' });
    expect(Date.parse(body.state.drafts['channel:one'].updatedAt)).toBeGreaterThan(0);
  });

  it('tombstones drafts when text is empty and ships the deletion in sync', async () => {
    const { cookie, user } = await login();
    expect((await putDraft(cookie, 'channel:one', 'hello')).statusCode).toBe(200);
    expect((await putDraft(cookie, 'channel:one', '')).statusCode).toBe(200);

    const row = await pool.query<{ text: string; deleted_at: Date | null }>(
      'SELECT text, deleted_at FROM user_drafts WHERE user_id = $1 AND draft_key = $2',
      [user.id, 'channel:one'],
    );
    expect(row.rows[0]?.text).toBe('');
    expect(row.rows[0]?.deleted_at).toBeInstanceOf(Date);

    const body = await sync(cookie);
    expect(body.state.drafts).not.toHaveProperty('channel:one');
    expect(Date.parse(body.state.draftDeletions['channel:one'])).toBeGreaterThan(0);
  });

  it('resurrects tombstoned drafts on re-upsert', async () => {
    const { cookie, user } = await login();
    expect((await putDraft(cookie, 'channel:one', 'hello')).statusCode).toBe(200);
    expect((await putDraft(cookie, 'channel:one', '')).statusCode).toBe(200);
    expect((await putDraft(cookie, 'channel:one', 'back')).statusCode).toBe(200);

    const row = await pool.query<{ text: string; deleted_at: Date | null }>(
      'SELECT text, deleted_at FROM user_drafts WHERE user_id = $1 AND draft_key = $2',
      [user.id, 'channel:one'],
    );
    expect(row.rows[0]).toMatchObject({ text: 'back', deleted_at: null });

    const body = await sync(cookie);
    expect(body.state.drafts['channel:one']).toMatchObject({ text: 'back' });
    expect(body.state.draftDeletions).not.toHaveProperty('channel:one');
  });

  it('prunes only draft tombstones older than 30 days', async () => {
    const { user } = await login();
    await pool.query(
      `INSERT INTO user_drafts (user_id, draft_key, text, updated_at, deleted_at)
       VALUES
         ($1, 'old', '', now() - interval '31 days', now() - interval '31 days'),
         ($1, 'recent', '', now() - interval '29 days', now() - interval '29 days'),
         ($1, 'live', 'hello', now() - interval '31 days', NULL)`,
      [user.id],
    );

    await pruneDraftTombstones(pool);

    const rows = await pool.query<{ draft_key: string }>(
      'SELECT draft_key FROM user_drafts WHERE user_id = $1 ORDER BY draft_key ASC',
      [user.id],
    );
    expect(rows.rows.map((row) => row.draft_key)).toEqual(['live', 'recent']);
  });

  it('replays a draft opId without reapplying the upsert', async () => {
    const { cookie, user } = await login();
    const opId = randomUUID();
    expect((await putDraft(cookie, 'channel:one', 'hello', opId)).statusCode).toBe(200);
    await pool.query('UPDATE user_drafts SET text = $1 WHERE user_id = $2 AND draft_key = $3', [
      'manual edit',
      user.id,
      'channel:one',
    ]);

    expect((await putDraft(cookie, 'channel:one', 'hello', opId)).statusCode).toBe(200);
    const row = await pool.query<{ text: string }>(
      'SELECT text FROM user_drafts WHERE user_id = $1 AND draft_key = $2',
      [user.id, 'channel:one'],
    );
    expect(row.rows[0]?.text).toBe('manual edit');
  });
});
