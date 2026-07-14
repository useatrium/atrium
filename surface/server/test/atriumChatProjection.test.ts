import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadChannelChatProjection } from '../src/atrium-channel-projection.js';
import { deleteMessage, editMessage, postMessage, suppressUnfurls } from '../src/events.js';
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

async function loginCookie(): Promise<{ cookie: string; userId: string }> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  expect(login.statusCode).toBe(200);
  const userId = login.json().user.id as string;
  await addWorkspaceMember(pool, fx.workspaceId, userId);
  return { cookie: login.headers['set-cookie'] as string, userId };
}

async function insertSession(userId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id)
     VALUES ($1, $2, $3, 'claude-code', 'projection', 'running', $4, $4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `thread-${randomUUID()}`, userId],
  );
  return r.rows[0]!.id;
}

describe('GET /api/sessions/:id/atrium/chat', () => {
  it('renders the current chat view with edits applied and deletes omitted', async () => {
    const { cookie, userId } = await loginCookie();
    const sid = await insertSession(userId);
    const edited = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: userId,
      text: 'original text',
    });
    const edit = await editMessage(pool, {
      targetEventId: edited.id,
      actorId: userId,
      text: 'edited text',
    });
    await suppressUnfurls(pool, {
      targetEventId: edited.id,
      actorId: userId,
      suppressed: ['evt_123'],
    });
    const deleted = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: userId,
      text: 'deleted secret text',
    });
    await deleteMessage(pool, { targetEventId: deleted.id, actorId: userId });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/atrium/chat?channel=${encodeURIComponent(fx.channelId)}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { markdown: string; messageCount: number };
    expect(body.messageCount).toBe(1);
    expect(body.markdown).toContain('edited text');
    expect(body.markdown).not.toContain('original text');
    expect(body.markdown).not.toContain('deleted secret text');

    const projection = await loadChannelChatProjection(pool, fx.channelId, edit.id);
    expect(projection.historyMutated).toBe(true);
    expect(projection.messages[0]?.suppressedUnfurls).toEqual(['evt_123']);
  });
});
