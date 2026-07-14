// Route-level coverage for the audit-driven server fixes: message editing,
// re-login display-name keep, and 404 (not 500) for mangled session ids.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
let hub: WsHub;

beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
  hub = new WsHub();
  app = await buildApp({
    pool,
    hub,
    // Never reached by these tests; autoResume off keeps boot DB-only.
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

function fakeSocket(): HubSocket & { received: any[] } {
  const received: any[] = [];
  return {
    readyState: 1,
    received,
    send(data: string) {
      received.push(JSON.parse(data));
    },
  };
}
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

async function reactionNet(targetEventId: number, actorId: string, emoji: string): Promise<number> {
  const res = await pool.query<{ net: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type = 'reaction.added' THEN 1 ELSE -1 END), 0)::int AS net
     FROM events
     WHERE type IN ('reaction.added', 'reaction.removed')
       AND payload->>'target' = $1
       AND actor_id = $2
       AND payload->>'emoji' = $3`,
    [`evt_${targetEventId}`, actorId, emoji],
  );
  return res.rows[0]?.net ?? 0;
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
    expect(ev.payload.target).toBe(`evt_${msg.id}`);
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

describe('PUT /api/messages/:id/unfurls-suppressed', () => {
  it('lets the author replace the suppression set and fans out the live event', async () => {
    const { cookie, user } = await login('alice', 'Alice');
    const socket = fakeSocket();
    const client = hub.addClient(socket, user);
    hub.subscribe(client, [fx.channelId]);
    socket.received.length = 0;
    const msg = await post(cookie, 'links');

    const first = await app.inject({
      method: 'PUT',
      url: `/api/messages/${msg.id}/unfurls-suppressed`,
      headers: { cookie },
      payload: { suppressed: ['evt_123', 'art_00000000-0000-0000-0000-000000000001'] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().event).toMatchObject({
      type: 'message.unfurls_suppressed',
      payload: { target: `evt_${msg.id}`, suppressed: ['evt_123', 'art_00000000-0000-0000-0000-000000000001'] },
    });

    const second = await app.inject({
      method: 'PUT',
      url: `/api/messages/${msg.id}/unfurls-suppressed`,
      headers: { cookie },
      payload: { suppressed: ['evt_123'] },
    });
    expect(second.statusCode).toBe(200);

    const read = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages`,
      headers: { cookie },
    });
    const row = read.json().events.find((event: any) => event.id === msg.id);
    expect(row.payload.suppressed_unfurls).toEqual(['evt_123']);

    const liveEvents = socket.received.filter((message) => message.type === 'event').map((message) => message.event);
    expect(liveEvents.filter((event) => event.type === 'message.unfurls_suppressed')).toHaveLength(2);
    expect(liveEvents.at(-1)).toMatchObject({
      type: 'message.unfurls_suppressed',
      payload: { target: `evt_${msg.id}`, suppressed: ['evt_123'] },
    });
  });

  it('rejects non-authors, missing messages, and invalid suppression sets', async () => {
    const { cookie: aliceCookie } = await login('alice', 'Alice');
    const { cookie: benCookie } = await login('ben', 'Ben');
    const msg = await post(aliceCookie, 'mine');

    const forbidden = await app.inject({
      method: 'PUT',
      url: `/api/messages/${msg.id}/unfurls-suppressed`,
      headers: { cookie: benCookie },
      payload: { suppressed: ['evt_123'] },
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'PUT',
      url: '/api/messages/999999/unfurls-suppressed',
      headers: { cookie: aliceCookie },
      payload: { suppressed: [] },
    });
    expect(missing.statusCode).toBe(404);

    for (const suppressed of [
      'evt_123',
      [''],
      ['evt_123', 'evt_123'],
      Array.from({ length: 101 }, (_, i) => `evt_${i}`),
    ]) {
      const invalid = await app.inject({
        method: 'PUT',
        url: `/api/messages/${msg.id}/unfurls-suppressed`,
        headers: { cookie: aliceCookie },
        payload: { suppressed },
      });
      expect(invalid.statusCode).toBe(400);
    }
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

describe('POST /api/messages/:id/reactions', () => {
  it('adds, aggregates per emoji in reads, and explicit remove clears membership', async () => {
    const { cookie: alice, user: aliceUser } = await login('alice', 'Alice');
    const { cookie: ben, user: benUser } = await login('ben', 'Ben');
    const msg = await post(alice, 'react to me');

    const r1 = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie: alice },
      payload: { emoji: '👍', action: 'add' },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().event.type).toBe('reaction.added');
    await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie: ben },
      payload: { emoji: '👍', action: 'add' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie: ben },
      payload: { emoji: '🎉', action: 'add' },
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

    // Explicit remove clears ben's 👍.
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie: ben },
      payload: { emoji: '👍', action: 'remove' },
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

  it('treats add-when-present and remove-when-absent as successful no-ops', async () => {
    const { cookie } = await login('alice', 'Alice');
    const msg = await post(cookie, 'react once');

    const added = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie },
      payload: { emoji: '👍', action: 'add' },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().event.type).toBe('reaction.added');

    const addAgain = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie },
      payload: { emoji: '👍', action: 'add' },
    });
    expect(addAgain.statusCode).toBe(200);
    expect(addAgain.json()).toEqual({ event: null, applied: false });

    const removed = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie },
      payload: { emoji: '👍', action: 'remove' },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().event.type).toBe('reaction.removed');

    const removeAgain = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie },
      payload: { emoji: '👍', action: 'remove' },
    });
    expect(removeAgain.statusCode).toBe(200);
    expect(removeAgain.json()).toEqual({ event: null, applied: false });
  });

  it('serializes concurrent same-user removes without driving the stored net negative', async () => {
    const { cookie, user } = await login('alice', 'Alice');
    const msg = await post(cookie, 'remove race');
    const added = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
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
      await blocker.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [msg.id]);

      const remove = (opId: string) =>
        app.inject({
          method: 'POST',
          url: `/api/messages/${msg.id}/reactions`,
          headers: { cookie },
          payload: { emoji: '👍', action: 'remove', opId },
        });
      const first = remove(randomUUID());
      const second = remove(randomUUID());
      // Give both requests time to queue behind the intentionally held row lock.
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

    const removedNet = await reactionNet(msg.id, user.id, '👍');
    expect(removedNet).toBeGreaterThanOrEqual(0);
    expect(removedNet).toBe(0);

    const addAgain = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie },
      payload: { emoji: '👍', action: 'add', opId: randomUUID() },
    });
    expect(addAgain.statusCode).toBe(200);
    expect(addAgain.json().event.type).toBe('reaction.added');
    expect(await reactionNet(msg.id, user.id, '👍')).toBe(1);

    const read = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages`,
      headers: { cookie },
    });
    const row = read.json().events.find((e: any) => e.id === msg.id);
    expect(row.payload.reactions).toEqual([{ emoji: '👍', userIds: [user.id] }]);
  });

  it('rejects emojis outside the allowlist and missing targets', async () => {
    const { cookie } = await login('alice', 'Alice');
    const msg = await post(cookie, 'x');
    const bad = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie },
      payload: { emoji: '<script>', action: 'add' },
    });
    expect(bad.statusCode).toBe(400);
    const missingAction = await app.inject({
      method: 'POST',
      url: `/api/messages/${msg.id}/reactions`,
      headers: { cookie },
      payload: { emoji: '👍' },
    });
    expect(missingAction.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/messages/999999/reactions',
      headers: { cookie },
      payload: { emoji: '👍', action: 'add' },
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

describe('attachments', () => {
  async function insertFile(uploaderId: string, over: Record<string, unknown> = {}) {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO files (workspace_id, uploader_id, filename, content_type, size_bytes, width, height, s3_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        fx.workspaceId,
        uploaderId,
        over.filename ?? 'shot.png',
        over.contentType ?? 'image/png',
        over.size ?? 12345,
        over.width ?? 800,
        over.height ?? 600,
        'k/shot.png',
      ],
    );
    return res.rows[0]!.id;
  }

  it('embeds attachment metadata into the message payload', async () => {
    const { cookie, user } = await login('alice', 'Alice');
    const fileId = await insertFile(user.id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie },
      payload: { channelId: fx.channelId, text: '', clientMsgId: 'cm-att', attachments: [fileId] },
    });
    expect(res.statusCode).toBe(201);
    const ev = res.json().event;
    expect(ev.payload.attachments).toEqual([
      {
        id: fileId,
        filename: 'shot.png',
        contentType: 'image/png',
        size: 12345,
        width: 800,
        height: 600,
      },
    ]);
    // Attachment-only messages are allowed; text-and-attachment-free are not.
    const empty = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie },
      payload: { channelId: fx.channelId, text: '', clientMsgId: 'cm-none' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("rejects attaching someone else's upload", async () => {
    const { user: aliceUser } = await login('alice', 'Alice');
    const { cookie: benCookie } = await login('ben', 'Ben');
    const fileId = await insertFile(aliceUser.id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie: benCookie },
      payload: { channelId: fx.channelId, text: 'steal', attachments: [fileId] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_attachment');
  });

  it('GET /api/files/:id redirects to a presigned URL; unknown ids 404', async () => {
    const { cookie, user } = await login('alice', 'Alice');
    const fileId = await insertFile(user.id);
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${fileId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('k/shot.png');
    expect(res.headers.location).toContain('X-Amz-Signature');
    const missing = await app.inject({
      method: 'GET',
      url: '/api/files/not-a-uuid',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects oversize upload declarations before touching storage', async () => {
    const { cookie } = await login('alice', 'Alice');
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie },
      payload: { filename: 'big.bin', contentType: 'application/zip', size: 26 * 1024 * 1024 },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('GET /api/search (full-text)', () => {
  it('finds messages by current text, including edit-introduced terms, never deleted ones', async () => {
    const { cookie } = await login('alice', 'Alice');
    const hit = await post(cookie, 'the deploy pipeline is broken again');
    await post(cookie, 'unrelated chatter about lunch');
    const editTarget = await post(cookie, 'this says nothing interesting');
    await app.inject({
      method: 'PATCH',
      url: `/api/messages/${editTarget.id}`,
      headers: { cookie },
      payload: { text: 'edited to mention the pipeline too' },
    });
    const goner = await post(cookie, 'pipeline secrets to delete');
    await app.inject({
      method: 'DELETE',
      url: `/api/messages/${goner.id}`,
      headers: { cookie },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=pipeline',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const results = res.json().results as { event: any; channelName: string }[];
    const ids = results.map((r) => r.event.id);
    expect(ids).toContain(hit.id);
    expect(ids).toContain(editTarget.id); // edit introduced the term
    expect(ids).not.toContain(goner.id); // deleted never surfaces
    // Folded current text + channel name ride along.
    const edited = results.find((r) => r.event.id === editTarget.id)!;
    expect(edited.event.payload.text).toContain('edited to mention');
    expect(edited.channelName).toBeTruthy();

    const tooShort = await app.inject({
      method: 'GET',
      url: '/api/search?q=x',
      headers: { cookie },
    });
    expect(tooShort.statusCode).toBe(400);
  });
});

describe('private DMs', () => {
  it('find-or-create is idempotent; only members see the channel or its messages', async () => {
    const { cookie: alice, user: aliceUser } = await login('alice', 'Alice');
    const { cookie: ben, user: benUser } = await login('ben', 'Ben');
    const { cookie: carol } = await login('carol', 'Carol');

    const created = await app.inject({
      method: 'POST',
      url: '/api/dms',
      headers: { cookie: alice },
      payload: { userId: benUser.id },
    });
    expect(created.statusCode).toBe(201);
    const dm = created.json().channel;
    expect(dm.kind).toBe('dm');
    expect(dm.members.map((m: any) => m.id).sort()).toEqual([aliceUser.id, benUser.id].sort());

    // Same pair again (from either side) returns the same channel.
    const again = await app.inject({
      method: 'POST',
      url: '/api/dms',
      headers: { cookie: ben },
      payload: { userId: aliceUser.id },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().channel.id).toBe(dm.id);

    // Members can post and read.
    const posted = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie: alice },
      payload: { channelId: dm.id, text: 'secret plans', clientMsgId: 'dm-1' },
    });
    expect(posted.statusCode).toBe(201);
    const benRead = await app.inject({
      method: 'GET',
      url: `/api/channels/${dm.id}/messages`,
      headers: { cookie: ben },
    });
    expect(benRead.statusCode).toBe(200);
    expect(benRead.json().events.some((e: any) => e.payload.text === 'secret plans')).toBe(true);

    // Non-members: channel invisible in lists, unreadable, unpostable,
    // and the DM's messages never appear in their search.
    const carolChannels = await app.inject({
      method: 'GET',
      url: '/api/channels',
      headers: { cookie: carol },
    });
    expect(carolChannels.json().channels.some((c: any) => c.id === dm.id)).toBe(false);
    const carolRead = await app.inject({
      method: 'GET',
      url: `/api/channels/${dm.id}/messages`,
      headers: { cookie: carol },
    });
    expect(carolRead.statusCode).toBe(404);
    const carolPost = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie: carol },
      payload: { channelId: dm.id, text: 'intruder', clientMsgId: 'dm-x' },
    });
    expect(carolPost.statusCode).toBe(404);
    const carolSearch = await app.inject({
      method: 'GET',
      url: '/api/search?q=secret',
      headers: { cookie: carol },
    });
    expect(carolSearch.json().results).toHaveLength(0);
    const aliceSearch = await app.inject({
      method: 'GET',
      url: '/api/search?q=secret',
      headers: { cookie: alice },
    });
    expect(aliceSearch.json().results.length).toBeGreaterThan(0);
  });

  it('threads inside DMs are member-only too', async () => {
    const { cookie: alice } = await login('alice', 'Alice');
    const { user: benUser } = await login('ben', 'Ben');
    const { cookie: carol } = await login('carol', 'Carol');
    const dm = (
      await app.inject({
        method: 'POST',
        url: '/api/dms',
        headers: { cookie: alice },
        payload: { userId: benUser.id },
      })
    ).json().channel;
    const root = (
      await app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { cookie: alice },
        payload: { channelId: dm.id, text: 'thread root', clientMsgId: 'dm-r' },
      })
    ).json().event;
    const carolThread = await app.inject({
      method: 'GET',
      url: `/api/threads/${root.id}/messages`,
      headers: { cookie: carol },
    });
    expect(carolThread.statusCode).toBe(404);
    const aliceThread = await app.inject({
      method: 'GET',
      url: `/api/threads/${root.id}/messages`,
      headers: { cookie: alice },
    });
    expect(aliceThread.statusCode).toBe(200);
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
