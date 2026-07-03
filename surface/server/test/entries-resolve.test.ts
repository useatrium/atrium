import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger } from '../src/artifact-ledger.js';
import { config } from '../src/config.js';
import { signSession } from '../src/cookie.js';
import { encodeArtifactHandle, encodeEventHandle, encodeRecordHandle } from '../src/entries.js';
import { createChannel, postMessage } from '../src/events.js';
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
  const token = signSession(res.rows[0]!.id, config.sessionSecret);
  return `${config.sessionCookie}=${token}`;
}

async function insertSession(args: {
  channelId?: string;
  workspaceId?: string;
  spawnedBy?: string;
  title?: string;
} = {}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1, $2, $3, 'codex', $4, 'completed', $5)
     RETURNING id`,
    [
      args.workspaceId ?? fx.workspaceId,
      args.channelId ?? fx.channelId,
      `entries-resolve:${randomUUID()}`,
      args.title ?? 'Resolve target',
      args.spawnedBy ?? fx.userId,
    ],
  );
  return res.rows[0]!.id;
}

async function insertRecord(args: {
  sessionId: string;
  entryUid: string;
  seq?: number;
  kind?: string;
  actor?: string;
  text: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const seq = args.seq ?? 0;
  await pool.query(
    `INSERT INTO session_records
       (session_id, entry_uid, event_id, seq, kind, actor, driver, view_tier, text, meta, ts)
     VALUES ($1, $2, $3, $4, $5, $6, 'codex', 'lean', $7, $8::jsonb, $9::timestamptz)`,
    [
      args.sessionId,
      args.entryUid,
      seq + 1,
      seq,
      args.kind ?? 'message',
      args.actor ?? 'agent',
      args.text,
      JSON.stringify(args.meta ?? {}),
      `2026-01-01T00:00:0${seq}.000Z`,
    ],
  );
}

async function insertUploadArtifact(): Promise<{ artifactId: string; path: string }> {
  const token = randomUUID().replace(/-/g, '');
  const path = `shared/channels/${fx.channelId}/uploads/resolve-${token}.txt`;
  const result = await new ArtifactLedger(pool).commitUpload({
    workspaceId: fx.workspaceId,
    channelId: fx.channelId,
    path,
    blobSha: `${token}${token}`.slice(0, 64),
    sizeBytes: 12,
    mime: 'text/plain',
    author: `human:${fx.userId}`,
  });
  return { artifactId: result.artifactId, path };
}

describe('GET /api/entries/:handle', () => {
  it('resolves a chat event for a channel reader and hides it from a non-member', async () => {
    const memberCookie = await authCookie(fx.userId);
    const strangerId = await insertUser('entry-stranger');
    const strangerCookie = await authCookie(strangerId);

    const event = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'chat entry text',
    });
    const handle = encodeEventHandle(event.id);
    expect(event.handle).toBe(handle);

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/entries/${handle}`,
      headers: { cookie: memberCookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      handle,
      kind: 'message.posted',
      actor: fx.userId,
      text: 'chat entry text',
      meta: { text: 'chat entry text' },
      targetType: 'event',
      sourceRefs: [],
      tombstoned: false,
      location: {
        workspaceId: fx.workspaceId,
        channelId: fx.channelId,
        channelName: 'general',
        sessionId: null,
        sessionTitle: null,
      },
    });

    const denied = await app.inject({
      method: 'GET',
      url: `/api/entries/${handle}`,
      headers: { cookie: strangerCookie },
    });
    expect(denied.statusCode).toBe(404);
  });

  it('resolves transcript records through each session visibility grant', async () => {
    const strangerId = await insertUser('record-stranger');
    const strangerCookie = await authCookie(strangerId);

    const workspaceMemberId = await insertUser('workspace-member');
    await addWorkspaceMember(pool, fx.workspaceId, workspaceMemberId);
    const workspaceMemberCookie = await authCookie(workspaceMemberId);
    const publicSession = await insertSession({ title: 'Public resolve target' });
    await insertRecord({
      sessionId: publicSession,
      entryUid: 'public_visible_record',
      text: 'public workspace record text',
      meta: { sourceEventIds: [11, 'evt_external'] },
    });

    const ownerId = await insertUser('private-owner');
    const { channel: memberChannel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'resolve-private-member',
      actorId: ownerId,
      private: true,
    });
    const channelMemberId = await insertUser('channel-member');
    await pool.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [
      memberChannel.id,
      channelMemberId,
    ]);
    const channelMemberCookie = await authCookie(channelMemberId);
    const memberSession = await insertSession({
      channelId: memberChannel.id,
      spawnedBy: ownerId,
      title: 'Private channel member target',
    });
    await insertRecord({
      sessionId: memberSession,
      entryUid: 'private_member_record',
      actor: 'user',
      text: 'private channel member record text',
    });

    const spawnedUserId = await insertUser('spawned-viewer');
    const spawnedCookie = await authCookie(spawnedUserId);
    const { channel: spawnedChannel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'resolve-private-spawned',
      actorId: ownerId,
      private: true,
    });
    const spawnedSession = await insertSession({
      channelId: spawnedChannel.id,
      spawnedBy: spawnedUserId,
      title: 'Spawned-by target',
    });
    await insertRecord({
      sessionId: spawnedSession,
      entryUid: 'spawned_visible_record',
      kind: 'command',
      text: 'spawned by record text',
    });

    for (const [cookie, uid, text] of [
      [workspaceMemberCookie, 'public_visible_record', 'public workspace record text'],
      [channelMemberCookie, 'private_member_record', 'private channel member record text'],
      [spawnedCookie, 'spawned_visible_record', 'spawned by record text'],
    ] as const) {
      const handle = encodeRecordHandle(uid);
      const allowed = await app.inject({
        method: 'GET',
        url: `/api/entries/${handle}`,
        headers: { cookie },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({
        handle,
        text,
        targetType: 'record',
        tombstoned: false,
      });
    }

    const withRefs = await app.inject({
      method: 'GET',
      url: `/api/entries/${encodeRecordHandle('public_visible_record')}`,
      headers: { cookie: workspaceMemberCookie },
    });
    expect(withRefs.json().sourceRefs).toEqual(['11', 'evt_external']);
    expect(withRefs.json().location).toEqual({
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      channelName: 'general',
      sessionId: publicSession,
      sessionTitle: 'Public resolve target',
    });

    for (const uid of ['public_visible_record', 'private_member_record', 'spawned_visible_record']) {
      const denied = await app.inject({
        method: 'GET',
        url: `/api/entries/${encodeRecordHandle(uid)}`,
        headers: { cookie: strangerCookie },
      });
      expect(denied.statusCode).toBe(404);
    }
  });

  it('resolves file artifacts for artifact readers and hides them from non-readers', async () => {
    const memberCookie = await authCookie(fx.userId);
    const strangerId = await insertUser('artifact-entry-stranger');
    const strangerCookie = await authCookie(strangerId);

    const { artifactId, path } = await insertUploadArtifact();
    const handle = encodeArtifactHandle(artifactId);

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/entries/${handle}`,
      headers: { cookie: memberCookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      handle,
      kind: 'artifact',
      actor: null,
      text: path.split('/').at(-1),
      meta: {
        artifactId,
        workspaceId: fx.workspaceId,
        channelId: fx.channelId,
        path,
      },
      targetType: 'artifact',
      sourceRefs: [],
      tombstoned: false,
      location: {
        workspaceId: fx.workspaceId,
        channelId: fx.channelId,
        channelName: 'general',
        sessionId: null,
        sessionTitle: null,
      },
    });

    const denied = await app.inject({
      method: 'GET',
      url: `/api/entries/${handle}`,
      headers: { cookie: strangerCookie },
    });
    expect(denied.statusCode).toBe(404);
  });

  it('rejects malformed and reserved handles', async () => {
    const cookie = await authCookie(fx.userId);
    for (const handle of ['evt_nope', 'run_pending']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/entries/${handle}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'bad_handle' });
    }
  });
});
