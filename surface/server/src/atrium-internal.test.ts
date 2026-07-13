import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppDeps } from './app.js';
import type { Fixture } from '../test/helpers.js';

const KEY = 'atrium-internal-test-key';
const oldKey = process.env.ARTIFACT_CAPTURE_API_KEY;
const oldFullView = process.env.ATRIUM_FULL_VIEW;

let pool: pg.Pool;
let fx: Fixture;
let app: FastifyInstance;
let config: typeof import('./config.js').config;
let buildApp: (deps: AppDeps) => Promise<FastifyInstance>;
let createTestPool: typeof import('../test/helpers.js').createTestPool;
let seedFixture: typeof import('../test/helpers.js').seedFixture;
let seedMember: typeof import('../test/helpers.js').seedMember;
let truncateAll: typeof import('../test/helpers.js').truncateAll;
let createChannel: typeof import('./events.js').createChannel;
let deleteMessage: typeof import('./events.js').deleteMessage;
let emitSessionRecordChange: typeof import('./session-record-changefeed.js').emitSessionRecordChange;
let editMessage: typeof import('./events.js').editMessage;
let postMessage: typeof import('./events.js').postMessage;

beforeAll(async () => {
  process.env.ARTIFACT_CAPTURE_API_KEY = KEY;
  process.env.ATRIUM_FULL_VIEW = '1';
  vi.resetModules();
  ({ createTestPool, seedFixture, seedMember, truncateAll } = await import('../test/helpers.js'));
  ({ config } = await import('./config.js'));
  ({ buildApp } = await import('./app.js'));
  ({ createChannel, deleteMessage, editMessage, postMessage } = await import('./events.js'));
  ({ emitSessionRecordChange } = await import('./session-record-changefeed.js'));
  pool = await createTestPool();
});

afterAll(async () => {
  if (pool) await pool.end();
  if (oldKey == null) {
    delete process.env.ARTIFACT_CAPTURE_API_KEY;
  } else {
    process.env.ARTIFACT_CAPTURE_API_KEY = oldKey;
  }
  if (oldFullView == null) {
    delete process.env.ATRIUM_FULL_VIEW;
  } else {
    process.env.ATRIUM_FULL_VIEW = oldFullView;
  }
});

beforeEach(async () => {
  await truncateAll(pool);
  config.fullViewEnabled = true;
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

async function grantRawAccess(userId: string): Promise<void> {
  await pool.query(`UPDATE users SET raw_access = true WHERE id = $1`, [userId]);
}

async function login(handle: string, displayName = handle): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return res.headers['set-cookie'] as string;
}

async function insertSession(
  args: { channelId?: string; workspaceId?: string; spawnedBy?: string; driverId?: string | null; title?: string } = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id)
     VALUES ($1, $2, $3, 'codex', $4, 'completed', $5, $6)
     RETURNING id`,
    [
      args.workspaceId ?? fx.workspaceId,
      args.channelId ?? fx.channelId,
      `atrium-internal:${randomUUID()}`,
      args.title ?? 'Atrium internal session',
      args.spawnedBy ?? fx.userId,
      args.driverId === undefined ? (args.spawnedBy ?? fx.userId) : args.driverId,
    ],
  );
  return res.rows[0]!.id;
}

async function insertDmChannel(memberIds: string[]): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO channels (workspace_id, name, kind, created_by)
     VALUES ($1, $2, 'dm', $3)
     RETURNING id`,
    [fx.workspaceId, `dm-${randomUUID()}`, memberIds[0] ?? null],
  );
  for (const memberId of memberIds) {
    await pool.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [res.rows[0]!.id, memberId]);
  }
  return res.rows[0]!.id;
}

async function insertRecord(args: {
  sessionId: string;
  seq: number;
  eventId?: number;
  kind: string;
  actor?: string;
  driver?: string | null;
  viewTier: 'lean' | 'full';
  text: string;
  meta?: Record<string, unknown>;
  ts?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO session_records
       (session_id, event_id, seq, kind, actor, driver, view_tier, text, meta, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz)`,
    [
      args.sessionId,
      args.eventId ?? args.seq + 1,
      args.seq,
      args.kind,
      args.actor ?? 'agent',
      args.driver ?? 'codex',
      args.viewTier,
      args.text,
      JSON.stringify(args.meta ?? {}),
      args.ts ?? `2026-01-01T00:00:0${args.seq}.000Z`,
    ],
  );
}

async function insertCompletedSessionEvent(sessionId: string, text: string): Promise<void> {
  const frame = {
    event: 'amp_raw_event',
    event_id: 1,
    data: {
      type: 'item.completed',
      item: { id: 'user-1', type: 'userMessage', text },
    },
  };
  await pool.query(
    `INSERT INTO session_events
       (session_id, centaur_event_id, event_kind, frame, created_at)
     VALUES ($1, 1, 'amp_raw_event', $2::jsonb, '2026-01-01T00:00:01.000Z')`,
    [sessionId, JSON.stringify(frame)],
  );
}

async function seedViewerAndTarget(): Promise<{ viewerId: string; targetId: string }> {
  const viewerId = await insertSession({ title: 'Viewer node session' });
  const targetId = await insertSession({ title: 'Target projected session' });
  await insertRecord({
    sessionId: targetId,
    seq: 0,
    kind: 'message',
    actor: 'user',
    viewTier: 'lean',
    text: 'Please repair the sprocket index.',
  });
  await insertRecord({
    sessionId: targetId,
    seq: 1,
    kind: 'reasoning',
    actor: 'agent',
    viewTier: 'full',
    text: 'Full-tier reasoning detail for node projection.',
  });
  await insertRecord({
    sessionId: targetId,
    seq: 2,
    kind: 'command',
    actor: 'agent',
    viewTier: 'lean',
    text: '$ pnpm test\nall good',
  });
  return { viewerId, targetId };
}

describe('internal /atrium node-facing routes', () => {
  it('requires x-api-key', async () => {
    const { viewerId, targetId } = await seedViewerAndTarget();

    const missing = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/changes`,
    });
    expect(missing.statusCode).toBe(401);

    const wrong = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript`,
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('returns session-record changes scoped to the viewer user and resumes by cursor', async () => {
    const { viewerId, targetId } = await seedViewerAndTarget();
    await emitSessionRecordChange(pool, targetId, 3);

    const first = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/changes?limit=1`,
      headers: { 'x-api-key': KEY },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      rows: { sessionId: string; cursor: { xid: string; id: string } }[];
      next_cursor: string;
    }>();
    expect(firstBody.rows).toHaveLength(1);
    expect(firstBody.rows[0]!.sessionId).toBe(targetId);
    expect(firstBody.next_cursor).toBe(`${firstBody.rows[0]!.cursor.xid}.${firstBody.rows[0]!.cursor.id}`);

    const second = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/changes?since=${firstBody.next_cursor}&limit=1`,
      headers: { 'x-api-key': KEY },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ rows: [], next_cursor: firstBody.next_cursor });
  });

  it('serves lean transcript and full transcript with the P3 renderers', async () => {
    await grantRawAccess(fx.userId);
    const { viewerId, targetId } = await seedViewerAndTarget();

    const transcript = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript`,
      headers: { 'x-api-key': KEY },
    });
    expect(transcript.statusCode).toBe(200);
    expect(transcript.headers['content-type']).toContain('text/markdown');
    expect(transcript.body).toContain('# Transcript');
    expect(transcript.body).toContain('Please repair the sprocket index.');
    expect(transcript.body).not.toContain('Full-tier reasoning detail');

    const full = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/full`,
      headers: { 'x-api-key': KEY },
    });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toContain('text/markdown');
    expect(full.body).toContain('# Full Transcript');
    expect(full.body).toContain('Full-tier reasoning detail for node projection.');

    const events = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/events`,
      headers: { 'x-api-key': KEY },
    });
    expect(events.statusCode).toBe(200);

    const cookie = await login('alice', 'Alice');
    const userFull = await app.inject({
      method: 'GET',
      url: `/api/sessions/${targetId}/atrium/full`,
      headers: { cookie },
    });
    expect(userFull.statusCode).toBe(200);
    expect(userFull.body).toContain('Full-tier reasoning detail for node projection.');

    const userEvents = await app.inject({
      method: 'GET',
      url: `/api/sessions/${targetId}/atrium/events`,
      headers: { cookie },
    });
    expect(userEvents.statusCode).toBe(200);
  });

  it('appends only session records after the acknowledged seq', async () => {
    const { viewerId, targetId } = await seedViewerAndTarget();
    const initial = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript`,
      headers: { 'x-api-key': KEY },
    });
    expect(initial.headers['x-atrium-delta']).toBe('full');
    expect(initial.headers['x-atrium-next-seq']).toBe('2');
    const epoch = String(initial.headers['x-atrium-epoch']);

    await insertRecord({
      sessionId: targetId,
      seq: 3,
      kind: 'message',
      actor: 'agent',
      viewTier: 'lean',
      text: 'Only this newly projected answer should be appended.',
    });
    const delta = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript?since_seq=2&epoch=${encodeURIComponent(epoch)}`,
      headers: { 'x-api-key': KEY },
    });

    expect(delta.statusCode).toBe(200);
    expect(delta.headers['x-atrium-delta']).toBe('append');
    expect(delta.headers['x-atrium-next-seq']).toBe('3');
    expect(delta.body).toContain('Only this newly projected answer should be appended.');
    expect(delta.body).not.toContain('# Transcript');
    expect(delta.body).not.toContain('Please repair the sprocket index.');
    const current = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript`,
      headers: { 'x-api-key': KEY },
    });
    expect(initial.body + delta.body).toBe(current.body);
  });

  it('downgrades an epoch mismatch and aggregate docs to full', async () => {
    const { viewerId, targetId } = await seedViewerAndTarget();
    const mismatch = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript?since_seq=1&epoch=stale`,
      headers: { 'x-api-key': KEY },
    });
    expect(mismatch.headers['x-atrium-delta']).toBe('full');
    expect(mismatch.body).toContain('# Transcript');
    const epoch = String(mismatch.headers['x-atrium-epoch']);

    for (const doc of ['summary', 'meta']) {
      const aggregate = await app.inject({
        method: 'GET',
        url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/${doc}?since_seq=1&epoch=${encodeURIComponent(epoch)}`,
        headers: { 'x-api-key': KEY },
      });
      expect(aggregate.statusCode).toBe(200);
      expect(aggregate.headers['x-atrium-delta']).toBe('full');
      expect(aggregate.headers['x-atrium-next-seq']).toBe('2');
    }
  });

  it('keeps no-since session bodies backward compatible', async () => {
    const { viewerId, targetId } = await seedViewerAndTarget();
    const internal = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript`,
      headers: { 'x-api-key': KEY },
    });
    const cookie = await login('alice', 'Alice');
    const existing = await app.inject({
      method: 'GET',
      url: `/api/sessions/${targetId}/atrium/transcript`,
      headers: { cookie },
    });

    expect(internal.headers['x-atrium-delta']).toBe('full');
    expect(internal.body).toBe(existing.body);
  });

  it('lists readable channels and excludes DMs unless they are the viewer session channel', async () => {
    const bobId = await seedMember(pool, fx.workspaceId, 'bob', 'Bob Jones');
    const dmId = await insertDmChannel([fx.userId, bobId]);

    const generalViewer = await insertSession({ title: 'General viewer' });
    const generalChannels = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${generalViewer}/atrium/channels`,
      headers: { 'x-api-key': KEY },
    });
    expect(generalChannels.statusCode).toBe(200);
    expect(generalChannels.json<{ id: string; active: boolean; kind: string }[]>()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fx.channelId, active: true, kind: 'public' })]),
    );
    expect(generalChannels.json<{ id: string }[]>().map((channel) => channel.id)).not.toContain(dmId);

    const dmViewer = await insertSession({ channelId: dmId, title: 'DM viewer' });
    const dmChannels = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${dmViewer}/atrium/channels`,
      headers: { 'x-api-key': KEY },
    });
    expect(dmChannels.statusCode).toBe(200);
    expect(dmChannels.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: dmId, active: true, kind: 'dm' })]),
    );
  });

  it('serves channel and chat docs with real names, anchors, threads, and current-view edits', async () => {
    await pool.query("UPDATE users SET display_name = 'Alice Basin' WHERE id = $1", [fx.userId]);
    const bobId = await seedMember(pool, fx.workspaceId, 'bob', 'Bob Jones');
    const viewerId = await insertSession({ driverId: bobId, title: 'Channel doc viewer' });
    const root = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'original pagination text',
    });
    const reply = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: bobId,
      text: 'Agreed, but cap page size.',
      threadRootEventId: root.id,
    });
    await editMessage(pool, {
      targetEventId: root.id,
      actorId: fx.userId,
      text: "Let's use cursor-based pagination...",
    });
    const deleted = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'deleted secret text',
    });
    await deleteMessage(pool, { targetEventId: deleted.id, actorId: fx.userId });
    await pool.query(
      `UPDATE events
          SET created_at = CASE id
            WHEN $1 THEN '2026-07-07T14:32:00Z'::timestamptz
            WHEN $2 THEN '2026-07-07T14:35:00Z'::timestamptz
            ELSE created_at
          END
        WHERE id IN ($1, $2)`,
      [root.id, reply.id],
    );

    const channel = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/channels/${fx.channelId}/channel`,
      headers: { 'x-api-key': KEY },
    });
    expect(channel.statusCode).toBe(200);
    expect(channel.body).toContain('# general');
    expect(channel.body).toContain('- this session driver: Bob Jones (@bob)');
    expect(channel.body).toContain('- Alice Basin (@alice)');

    const chat = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/channels/${fx.channelId}/chat`,
      headers: { 'x-api-key': KEY },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.body).toContain(`**Alice Basin** (@alice) · 2026-07-07 14:32 ⟨/e/evt_${root.id}⟩`);
    expect(chat.body).toContain("Let's use cursor-based pagination...");
    expect(chat.body).toContain(`  ↳ **Bob Jones** (@bob) · 14:35 ⟨/e/evt_${reply.id}⟩`);
    expect(chat.body).not.toContain('original pagination text');
    expect(chat.body).not.toContain('deleted secret text');
  });

  it('appends new channel messages but downgrades edits behind the watermark', async () => {
    const viewerId = await insertSession({ title: 'Channel delta viewer' });
    const root = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'stable root',
    });
    const initial = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/channels/${fx.channelId}/chat`,
      headers: { 'x-api-key': KEY },
    });
    const epoch = String(initial.headers['x-atrium-epoch']);
    expect(initial.headers['x-atrium-next-event-id']).toBe(String(root.id));

    const next = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'new tail message',
    });
    const appended = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/channels/${fx.channelId}/chat?since_event_id=${root.id}&epoch=${encodeURIComponent(epoch)}`,
      headers: { 'x-api-key': KEY },
    });
    expect(appended.headers['x-atrium-delta']).toBe('append');
    expect(appended.headers['x-atrium-next-event-id']).toBe(String(next.id));
    expect(appended.body).toContain('new tail message');
    expect(appended.body).not.toContain('stable root');
    const current = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/channels/${fx.channelId}/chat`,
      headers: { 'x-api-key': KEY },
    });
    expect(initial.body + appended.body).toBe(current.body);

    await editMessage(pool, {
      targetEventId: root.id,
      actorId: fx.userId,
      text: 'mutated root',
    });
    const edited = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/channels/${fx.channelId}/chat?since_event_id=${next.id}&epoch=${encodeURIComponent(epoch)}`,
      headers: { 'x-api-key': KEY },
    });
    expect(edited.headers['x-atrium-delta']).toBe('full');
    expect(edited.body).toContain('mutated root');
    expect(edited.body).toContain('new tail message');
  });

  it('gates full and events views while keeping lean transcript available', async () => {
    const { viewerId, targetId } = await seedViewerAndTarget();

    const internalTranscript = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript`,
      headers: { 'x-api-key': KEY },
    });
    expect(internalTranscript.statusCode).toBe(200);

    for (const doc of ['full', 'events']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/${doc}`,
        headers: { 'x-api-key': KEY },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'full_view_forbidden' });
    }

    const cookie = await login('alice', 'Alice');
    const userTranscript = await app.inject({
      method: 'GET',
      url: `/api/sessions/${targetId}/atrium/transcript`,
      headers: { cookie },
    });
    expect(userTranscript.statusCode).toBe(200);

    for (const doc of ['full', 'events']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${targetId}/atrium/${doc}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'full_view_forbidden' });
    }
  });

  it('reprojects a user-accessible session on demand and emits a change row', async () => {
    const targetId = await insertSession({ title: 'Reproject target' });
    await insertRecord({
      sessionId: targetId,
      seq: 0,
      kind: 'message',
      actor: 'user',
      viewTier: 'lean',
      text: 'Old projected text.',
    });
    await pool.query('INSERT INTO session_projection_state (session_id, last_event_id) VALUES ($1, 0)', [targetId]);
    await insertCompletedSessionEvent(targetId, 'Reprojected transcript text.');
    const cookie = await login('alice', 'Alice');

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${targetId}/atrium/reproject`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projected: 1 });
    const records = await pool.query<{ text: string }>(`SELECT text FROM session_records WHERE session_id = $1`, [
      targetId,
    ]);
    expect(records.rows.map((row) => row.text)).toEqual(['Reprojected transcript text.']);
    const changes = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM session_record_changes WHERE session_id = $1`,
      [targetId],
    );
    expect(Number(changes.rows[0]?.count ?? 0)).toBe(1);
    const generation = await pool.query<{ generation: string }>(
      'SELECT generation::text FROM session_projection_state WHERE session_id = $1',
      [targetId],
    );
    expect(generation.rows[0]?.generation).toBe('2');
  });

  it('404s for a private target the viewer user cannot access', async () => {
    const viewerId = await insertSession({ title: 'Viewer node session' });
    const ownerId = await insertUser('private-owner');
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'private-node-projection',
      actorId: ownerId,
      private: true,
    });
    const targetId = await insertSession({
      channelId: channel.id,
      workspaceId: fx.workspaceId,
      spawnedBy: ownerId,
      title: 'Private target',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'session_not_found' });
  });
});
