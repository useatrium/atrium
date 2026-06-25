import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { signSession } from '../src/cookie.js';
import { withTx } from '../src/db.js';
import { encodeEventHandle, encodeRecordHandle } from '../src/entries.js';
import {
  deleteCommentTx,
  editCommentTx,
  postMessage,
  type WireEvent,
} from '../src/events.js';
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
    calls: false,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function insertUser(handle: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    'INSERT INTO users (handle, display_name) VALUES ($1, $2) RETURNING id',
    [handle, handle],
  );
  return res.rows[0]!.id;
}

async function authCookie(userId: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, expires_at)
     VALUES ($1, now() + interval '30 days')
     RETURNING id`,
    [userId],
  );
  return `${config.sessionCookie}=${signSession(res.rows[0]!.id, config.sessionSecret)}`;
}

async function insertSession(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1, $2, $3, 'codex', 'Annotation target', 'completed', $4)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, `entry-annotation:${randomUUID()}`, fx.userId],
  );
  return res.rows[0]!.id;
}

async function insertRecord(entryUid: string): Promise<void> {
  const sessionId = await insertSession();
  await pool.query(
    `INSERT INTO session_records
       (session_id, entry_uid, event_id, seq, kind, actor, driver, view_tier, text, meta, ts)
     VALUES ($1, $2, 1, 0, 'message', 'agent', 'codex', 'lean', 'record text', '{}'::jsonb, $3::timestamptz)`,
    [sessionId, entryUid, '2026-01-01T00:00:00.000Z'],
  );
}

async function postComment(cookie: string, handle: string, text: string): Promise<WireEvent> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/entries/${handle}/comments`,
    headers: { cookie },
    payload: { text },
  });
  expect(res.statusCode).toBe(201);
  return res.json().event as WireEvent;
}

async function annotations(cookie: string, handle: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/entries/${handle}/annotations`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { comments: WireEvent[]; reactions: { emoji: string; userIds: string[] }[] };
}

async function reactionNet(handle: string, actorId: string, emoji: string): Promise<number> {
  const res = await pool.query<{ net: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type = 'reaction.added' THEN 1 ELSE -1 END), 0)::int AS net
       FROM events
      WHERE type IN ('reaction.added', 'reaction.removed')
        AND payload->>'target' = $1
        AND actor_id = $2
        AND payload->>'emoji' = $3`,
    [handle, actorId, emoji],
  );
  return res.rows[0]?.net ?? 0;
}

async function exerciseCommentLifecycle(cookie: string, handle: string): Promise<void> {
  const posted = await postComment(cookie, handle, 'initial note');
  expect(posted.type).toBe('comment.posted');
  expect(posted.payload).toMatchObject({ target: handle, text: 'initial note' });

  const edited = await withTx(pool, (client) =>
    editCommentTx(client, {
      commentEventId: posted.id,
      actorId: fx.userId,
      text: 'edited note',
    }),
  );
  expect(edited.type).toBe('comment.edited');
  expect(edited.payload).toMatchObject({ target: encodeEventHandle(posted.id), text: 'edited note' });

  let folded = await annotations(cookie, handle);
  expect(folded.comments).toHaveLength(1);
  expect(folded.comments[0]!.id).toBe(posted.id);
  expect(folded.comments[0]!.payload).toMatchObject({
    target: handle,
    text: 'edited note',
    edited: true,
  });

  const strangerId = await insertUser(`comment-stranger-${posted.id}`);
  await expect(
    withTx(pool, (client) =>
      editCommentTx(client, {
        commentEventId: posted.id,
        actorId: strangerId,
        text: 'hijack',
      }),
    ),
  ).rejects.toMatchObject({ statusCode: 403 });

  const deleted = await withTx(pool, (client) =>
    deleteCommentTx(client, { commentEventId: posted.id, actorId: fx.userId }),
  );
  expect(deleted.type).toBe('comment.deleted');
  expect(deleted.payload).toEqual({ target: encodeEventHandle(posted.id) });

  folded = await annotations(cookie, handle);
  expect(folded.comments).toHaveLength(1);
  expect(folded.comments[0]!.payload).toMatchObject({
    target: handle,
    text: '',
    deleted: true,
  });
}

describe('entry annotations', () => {
  it('posts, edits, deletes, and folds comments on chat events and transcript records', async () => {
    const cookie = await authCookie(fx.userId);
    const message = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'chat target',
    });
    await exerciseCommentLifecycle(cookie, encodeEventHandle(message.id));

    await insertRecord('annotation_record_comment');
    await exerciseCommentLifecycle(cookie, encodeRecordHandle('annotation_record_comment'));
  });

  it('tags agent-authored comments with via=agent (only "agent" honored)', async () => {
    const cookie = await authCookie(fx.userId);
    const message = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'agent comment target',
    });
    const handle = encodeEventHandle(message.id);

    // The MCP write tool sends via:"agent".
    const agentRes = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/comments`,
      headers: { cookie },
      payload: { text: 'looks correct', via: 'agent' },
    });
    expect(agentRes.statusCode).toBe(201);
    const agentEvent = agentRes.json().event as WireEvent;
    expect(agentEvent.payload).toMatchObject({ via: 'agent' });
    // actor stays the real principal; via is display-only attribution.
    expect(agentEvent.actorId).toBe(fx.userId);

    // A bogus via is ignored (not persisted).
    const bogusRes = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/comments`,
      headers: { cookie },
      payload: { text: 'human note', via: 'spoof' },
    });
    expect(bogusRes.statusCode).toBe(201);
    expect((bogusRes.json().event as WireEvent).payload.via).toBeUndefined();

    const folded = await annotations(cookie, handle);
    const agentComment = folded.comments.find((c) => c.payload.text === 'looks correct');
    expect(agentComment?.payload.via).toBe('agent');
  });

  it('sets entry reactions on evt_ and rec_ handles and keeps replays idempotent', async () => {
    const cookie = await authCookie(fx.userId);
    const message = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'reaction target',
    });
    const eventHandle = encodeEventHandle(message.id);

    const addEvent = await app.inject({
      method: 'POST',
      url: `/api/entries/${eventHandle}/reactions`,
      headers: { cookie },
      payload: { emoji: '👍', action: 'add' },
    });
    expect(addEvent.statusCode).toBe(200);
    expect(addEvent.json().event).toMatchObject({
      type: 'reaction.added',
      payload: { target: eventHandle, emoji: '👍' },
    });

    const addEventAgain = await app.inject({
      method: 'POST',
      url: `/api/entries/${eventHandle}/reactions`,
      headers: { cookie },
      payload: { emoji: '👍', action: 'add' },
    });
    expect(addEventAgain.statusCode).toBe(200);
    expect(addEventAgain.json()).toEqual({ event: null, applied: false });
    expect(await reactionNet(eventHandle, fx.userId, '👍')).toBe(1);
    expect((await annotations(cookie, eventHandle)).reactions).toEqual([
      { emoji: '👍', userIds: [fx.userId] },
    ]);

    await insertRecord('annotation_record_reaction');
    const recordHandle = encodeRecordHandle('annotation_record_reaction');
    const addRecord = await app.inject({
      method: 'POST',
      url: `/api/entries/${recordHandle}/reactions`,
      headers: { cookie },
      payload: { emoji: '🎉', action: 'add' },
    });
    expect(addRecord.statusCode).toBe(200);
    expect(addRecord.json().event).toMatchObject({
      type: 'reaction.added',
      channelId: fx.channelId,
      payload: { target: recordHandle, emoji: '🎉' },
    });

    const addRecordAgain = await app.inject({
      method: 'POST',
      url: `/api/entries/${recordHandle}/reactions`,
      headers: { cookie },
      payload: { emoji: '🎉', action: 'add' },
    });
    expect(addRecordAgain.statusCode).toBe(200);
    expect(addRecordAgain.json()).toEqual({ event: null, applied: false });
    expect(await reactionNet(recordHandle, fx.userId, '🎉')).toBe(1);
    expect((await annotations(cookie, recordHandle)).reactions).toEqual([
      { emoji: '🎉', userIds: [fx.userId] },
    ]);
  });

  it('serializes concurrent record reaction removes with the handle advisory lock', async () => {
    const cookie = await authCookie(fx.userId);
    await insertRecord('annotation_record_lock');
    const handle = encodeRecordHandle('annotation_record_lock');

    const added = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/reactions`,
      headers: { cookie },
      payload: { emoji: '👍', action: 'add', opId: randomUUID() },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().event.type).toBe('reaction.added');

    const blocker = await pool.connect();
    let locked = false;
    try {
      await blocker.query('BEGIN');
      locked = true;
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [handle]);

      const remove = (opId: string) =>
        app.inject({
          method: 'POST',
          url: `/api/entries/${handle}/reactions`,
          headers: { cookie },
          payload: { emoji: '👍', action: 'remove', opId },
        });
      const first = remove(randomUUID());
      const second = remove(randomUUID());
      await new Promise((resolve) => setTimeout(resolve, 50));
      await blocker.query('COMMIT');
      locked = false;

      const responses = await Promise.all([first, second]);
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
      }
    } finally {
      if (locked) await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }

    expect(await reactionNet(handle, fx.userId, '👍')).toBe(0);
    expect((await annotations(cookie, handle)).reactions).toEqual([]);
  });

  it('collapses inaccessible entries to 404 on all entry annotation routes', async () => {
    const message = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'private to workspace',
    });
    const handle = encodeEventHandle(message.id);
    const strangerId = await insertUser('annotation-outsider');
    const strangerCookie = await authCookie(strangerId);

    const read = await app.inject({
      method: 'GET',
      url: `/api/entries/${handle}/annotations`,
      headers: { cookie: strangerCookie },
    });
    expect(read.statusCode).toBe(404);

    const comment = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/comments`,
      headers: { cookie: strangerCookie },
      payload: { text: 'nope' },
    });
    expect(comment.statusCode).toBe(404);

    const reaction = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/reactions`,
      headers: { cookie: strangerCookie },
      payload: { emoji: '👍', action: 'add' },
    });
    expect(reaction.statusCode).toBe(404);
  });

  it('returns 400 for malformed handles and invalid entry reaction bodies', async () => {
    const cookie = await authCookie(fx.userId);

    for (const [method, url, payload] of [
      ['GET', '/api/entries/evt_nope/annotations', undefined],
      ['POST', '/api/entries/evt_nope/comments', { text: 'x' }],
      ['POST', '/api/entries/evt_nope/reactions', { emoji: '👍', action: 'add' }],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'bad_handle' });
    }

    await insertRecord('annotation_record_bad_reaction');
    const handle = encodeRecordHandle('annotation_record_bad_reaction');
    const badEmoji = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/reactions`,
      headers: { cookie },
      payload: { emoji: '<script>', action: 'add' },
    });
    expect(badEmoji.statusCode).toBe(400);

    const badAction = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/reactions`,
      headers: { cookie },
      payload: { emoji: '👍', action: 'toggle' },
    });
    expect(badAction.statusCode).toBe(400);
  });
});
