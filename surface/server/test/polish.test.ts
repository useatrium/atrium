// Route-level coverage for the audit-driven server fixes: message editing,
// re-login display-name keep, and 404 (not 500) for mangled session ids.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
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
    // Never reached by these tests; autoResume off keeps boot DB-only.
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

async function login(handle: string, displayName?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: displayName === undefined ? { handle } : { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string, user: res.json().user };
}

async function post(cookie: string, text: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { cookie },
    payload: { channelId: fx.channelId, text, clientMsgId: `cm-${Math.random()}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().event;
}

describe('PATCH /api/messages/:id (edit)', () => {
  it('lets the author edit; reads fold the new text with edited=true', async () => {
    const { cookie } = await login('alice', 'Alice');
    const msg = await post(cookie, 'typo here');

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msg.id}`,
      headers: { cookie },
      payload: { text: 'typo fixed' },
    });
    expect(edit.statusCode).toBe(200);
    const ev = edit.json().event;
    expect(ev.type).toBe('message.edited');
    expect(ev.payload.target_event_id).toBe(msg.id);
    expect(ev.payload.text).toBe('typo fixed');

    const read = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages`,
      headers: { cookie },
    });
    const row = read.json().events.find((e: any) => e.id === msg.id);
    expect(row.payload.text).toBe('typo fixed');
    expect(row.payload.edited).toBe(true);
  });

  it('rejects edits by non-authors (403) and of missing messages (404)', async () => {
    const { cookie: aliceCookie } = await login('alice', 'Alice');
    const { cookie: benCookie } = await login('ben', 'Ben');
    const msg = await post(aliceCookie, 'mine');

    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msg.id}`,
      headers: { cookie: benCookie },
      payload: { text: 'hijack' },
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/messages/999999',
      headers: { cookie: aliceCookie },
      payload: { text: 'x' },
    });
    expect(missing.statusCode).toBe(404);

    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msg.id}`,
      headers: { cookie: aliceCookie },
      payload: { text: '   ' },
    });
    expect(empty.statusCode).toBe(400);
  });
});

describe('DELETE /api/messages/:id', () => {
  it('author deletes: reads tombstone the text and reply counts exclude deleted replies', async () => {
    const { cookie } = await login('alice', 'Alice');
    const root = await post(cookie, 'root message');
    const replyRes = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie },
      payload: { channelId: fx.channelId, text: 'a reply', threadRootEventId: root.id },
    });
    const reply = replyRes.json().event;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${reply.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().event.type).toBe('message.deleted');

    // Thread read returns the reply as a tombstone with no text.
    const thread = await app.inject({
      method: 'GET',
      url: `/api/threads/${root.id}/messages`,
      headers: { cookie },
    });
    const tomb = thread.json().events.find((e: any) => e.id === reply.id);
    expect(tomb.payload.deleted).toBe(true);
    expect(tomb.payload.text).toBe('');

    // Channel read: root's reply count excludes the deleted reply.
    const read = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages`,
      headers: { cookie },
    });
    const rootRow = read.json().events.find((e: any) => e.id === root.id);
    expect(rootRow.replyCount).toBe(0);
  });

  it('rejects non-author deletes (403) and missing targets (404)', async () => {
    const { cookie: aliceCookie } = await login('alice', 'Alice');
    const { cookie: benCookie } = await login('ben', 'Ben');
    const msg = await post(aliceCookie, 'mine');
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${msg.id}`,
      headers: { cookie: benCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/messages/999999',
      headers: { cookie: aliceCookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /api/messages/:id/reactions (toggle)', () => {
  it('adds, aggregates per emoji in reads, and a second toggle removes', async () => {
    const { cookie: alice, user: aliceUser } = await login('alice', 'Alice');
    const { cookie: ben, user: benUser } = await login('ben', 'Ben');
    const msg = await post(alice, 'react to me');

    const r1 = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie: alice },
      payload: { emoji: '👍' },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().event.type).toBe('reaction.added');
    await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie: ben },
      payload: { emoji: '👍' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie: ben },
      payload: { emoji: '🎉' },
    });

    let read = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages`,
      headers: { cookie: alice },
    });
    let row = read.json().events.find((e: any) => e.id === msg.id);
    expect(row.payload.reactions).toEqual([
      { emoji: '👍', userIds: [aliceUser.id, benUser.id] },
      { emoji: '🎉', userIds: [benUser.id] },
    ]);

    // Toggling again removes ben's 👍.
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie: ben },
      payload: { emoji: '👍' },
    });
    expect(r2.json().event.type).toBe('reaction.removed');
    read = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages`,
      headers: { cookie: alice },
    });
    row = read.json().events.find((e: any) => e.id === msg.id);
    expect(row.payload.reactions).toEqual([
      { emoji: '👍', userIds: [aliceUser.id] },
      { emoji: '🎉', userIds: [benUser.id] },
    ]);
  });

  it('rejects emojis outside the allowlist and missing targets', async () => {
    const { cookie } = await login('alice', 'Alice');
    const msg = await post(cookie, 'x');
    const bad = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie },
      payload: { emoji: '<script>' },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/messages/999999/reactions',
      headers: { cookie },
      payload: { emoji: '👍' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('re-login display name', () => {
  it('keeps the existing display name when none is provided', async () => {
    await login('kay', 'Kay Largo');
    const { user } = await login('kay'); // bare re-login, e.g. handle only
    expect(user.displayName).toBe('Kay Largo');
    const blank = await login('kay', '');
    expect(blank.user.displayName).toBe('Kay Largo');
  });

  it('still updates when a new display name is explicitly provided', async () => {
    await login('kay', 'Kay Largo');
    const { user } = await login('kay', 'Kay L.');
    expect(user.displayName).toBe('Kay L.');
  });

  it('defaults a brand-new user with no display name to the handle', async () => {
    const { user } = await login('fresh');
    expect(user.displayName).toBe('fresh');
  });
});

describe('GET /api/sessions/:id with a mangled id', () => {
  it('returns 404, not a Postgres cast 500', async () => {
    const { cookie } = await login('alice', 'Alice');
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/does-not-exist',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('session_not_found');
  });
});
