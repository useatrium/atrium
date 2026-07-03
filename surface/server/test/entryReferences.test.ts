import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { signSession } from '../src/cookie.js';
import { encodeEventHandle } from '../src/entries.js';
import { createChannel, deleteMessage, getOrCreateDm, postMessage } from '../src/events.js';
import { seedMember } from './helpers.js';
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

async function authCookie(userId: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, expires_at)
     VALUES ($1, now() + interval '30 days')
     RETURNING id`,
    [userId],
  );
  return `${config.sessionCookie}=${signSession(res.rows[0]!.id, config.sessionSecret)}`;
}

describe('entry reference recording', () => {
  it('extracts relative and absolute entry links, drops invalids, dedupes, and caps at 10', async () => {
    const artifactHandle = 'art_123e4567-e89b-12d3-a456-426614174000';
    const event = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text:
        `refs /e/evt_001 https://example.test/e/rec_alpha-1 ` +
        `http://elsewhere.invalid/e/${artifactHandle} /e/run_later /e/evt_nope /e/evt_1`,
    });

    expect(event.payload.entry_refs).toEqual(['evt_1', 'rec_alpha-1', artifactHandle]);

    const capped = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: Array.from({ length: 12 }, (_, i) => `/e/evt_${100 + i}`).join(' '),
    });
    expect(capped.payload.entry_refs).toEqual(Array.from({ length: 10 }, (_, i) => `evt_${100 + i}`));

    const empty = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'no entry refs here',
    });
    expect(empty.payload).not.toHaveProperty('entry_refs');
  });

  it('records refs for thread replies and DMs through the same post path', async () => {
    const root = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'thread root',
    });
    const reply = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: '/e/evt_77 from a reply',
      threadRootEventId: root.id,
    });
    expect(reply.threadRootEventId).toBe(root.id);
    expect(reply.payload.entry_refs).toEqual(['evt_77']);

    const bobId = await seedMember(pool, fx.workspaceId, 'refs-bob', 'Bob');
    const { channel: dm } = await getOrCreateDm(pool, {
      workspaceId: fx.workspaceId,
      userIdA: fx.userId,
      userIdB: bobId,
    });
    const dmMessage = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: dm.id,
      actorId: fx.userId,
      text: 'dm ref /e/rec_dmRef',
    });
    expect(dmMessage.payload.entry_refs).toEqual(['rec_dmRef']);
  });
});

describe('POST /api/entries/references/query', () => {
  it('returns visible counts and newest three references, omits zero-ref handles, and filters private-channel refs', async () => {
    const aliceCookie = await authCookie(fx.userId);
    const bobId = await seedMember(pool, fx.workspaceId, 'refs-viewer', 'Refs Viewer');
    const bobCookie = await authCookie(bobId);
    const target = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'target entry',
    });
    const handle = encodeEventHandle(target.id);

    for (let i = 0; i < 4; i += 1) {
      await postMessage(pool, {
        workspaceId: fx.workspaceId,
        channelId: fx.channelId,
        actorId: fx.userId,
        text: `visible ref ${i} /e/${handle} ${'x'.repeat(180)}`,
      });
    }
    const reply = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: `latest reply discusses /e/${handle}`,
      threadRootEventId: target.id,
    });
    const { channel: privateChannel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'refs-private',
      actorId: fx.userId,
      private: true,
    });
    await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: privateChannel.id,
      actorId: fx.userId,
      text: `private ref /e/${handle}`,
    });

    const alice = await app.inject({
      method: 'POST',
      url: '/api/entries/references/query',
      headers: { cookie: aliceCookie },
      payload: { handles: [handle, 'rec_zero'] },
    });
    expect(alice.statusCode).toBe(200);
    expect(Object.keys(alice.json().references)).toEqual([handle]);
    expect(alice.json().references[handle].count).toBe(6);

    const bob = await app.inject({
      method: 'POST',
      url: '/api/entries/references/query',
      headers: { cookie: bobCookie },
      payload: { handles: [handle, 'rec_zero'] },
    });
    expect(bob.statusCode).toBe(200);
    const refs = bob.json().references[handle];
    expect(refs.count).toBe(5);
    expect(refs.latest).toHaveLength(3);
    expect(refs.latest[0]).toMatchObject({
      eventId: reply.id,
      handle: encodeEventHandle(reply.id),
      channelId: fx.channelId,
      threadRootEventId: target.id,
      actorLabel: 'Alice',
      excerpt: `latest reply discusses /e/${handle}`,
    });
    expect(refs.latest[0].ts).toEqual(expect.any(String));
    expect(refs.latest[1].excerpt.length).toBeLessThanOrEqual(140);
    expect(refs.latest.map((ref: { eventId: number }) => ref.eventId)).not.toContain(alice.json().references[handle].latest[0].eventId);
  });

  it('excludes references from deleted messages (no counts, no excerpt leak)', async () => {
    const cookie = await authCookie(fx.userId);
    const target = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'deletion target entry',
    });
    const handle = encodeEventHandle(target.id);
    const ref = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: `secret remark /e/${handle}`,
    });

    const before = await app.inject({
      method: 'POST',
      url: '/api/entries/references/query',
      headers: { cookie },
      payload: { handles: [handle] },
    });
    expect(before.json().references[handle]?.count).toBe(1);

    await deleteMessage(pool, { targetEventId: ref.id, actorId: fx.userId });

    const after = await app.inject({
      method: 'POST',
      url: '/api/entries/references/query',
      headers: { cookie },
      payload: { handles: [handle] },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().references[handle]).toBeUndefined();
  });

  it('rejects more than 200 handles', async () => {
    const cookie = await authCookie(fx.userId);
    const res = await app.inject({
      method: 'POST',
      url: '/api/entries/references/query',
      headers: { cookie },
      payload: { handles: Array.from({ length: 201 }, (_, i) => `evt_${i}`) },
    });
    expect(res.statusCode).toBe(400);
  });
});
