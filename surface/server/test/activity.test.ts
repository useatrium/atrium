import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedEvent, seedFixture, truncateAll, type Fixture } from './helpers.js';

interface Login {
  cookie: string;
  user: { id: string; handle: string; displayName: string };
}

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
    rateLimit: false,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('/api/activity', () => {
  it('returns mentions, DMs, and spawned-session events newest first', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const dm = await createDm(alice.cookie, bob.user.id);
    const mention = await post(alice.cookie, fx.channelId, 'hello @bob from the public channel');
    const direct = await post(alice.cookie, dm.id, 'direct hello');
    const question = await insertSessionEvent(bob.user.id, 'session.question_requested', {
      questions: [{ id: 'q1', header: 'Decision', question: 'Deploy now?' }],
    });
    const completed = await insertSessionEvent(bob.user.id, 'session.completed', {
      status: 'completed',
      resultExcerpt: 'Finished the requested change.',
    });

    const body = await activity(bob.cookie);

    expect(body.items.map((item: any) => [item.kind, Number(item.eventId)])).toEqual([
      ['session_completed', completed],
      ['agent_question', question],
      ['dm', direct.id],
      ['mention', mention.id],
    ]);
    expect(body.items[0]).toMatchObject({
      channelId: fx.channelId,
      channelName: 'general',
      actorId: bob.user.id,
      actorName: 'Bob',
      snippet: 'Finished the requested change.',
      sessionTitle: 'activity test',
      sessionStatus: 'running',
    });
    expect(body.items.find((item: any) => item.kind === 'agent_question')).toMatchObject({
      snippet: 'Deploy now?',
    });
    expect(body.items.find((item: any) => item.kind === 'mention')).toMatchObject({
      actorId: alice.user.id,
      actorName: 'Alice',
      snippet: 'hello @bob from the public channel',
    });

    const older = await activity(bob.cookie, String(question));
    expect(older.items.map((item: any) => item.kind)).toEqual(['dm', 'mention']);
    expect(body.nextCursor).toBeNull();
  });

  it('classifies failed completion and crash rows without duplicating terminal failures', async () => {
    const bob = await login('bob', 'Bob');
    const terminalSessionId = await createActivitySession(bob.user.id, 'terminal failure', 'failed');
    const duplicateStatus = await insertSessionEventFor(terminalSessionId, bob.user.id, 'session.status_changed', {
      status: 'failed',
    });
    const terminalCompleted = await insertSessionEventFor(terminalSessionId, bob.user.id, 'session.completed', {
      status: 'failed',
      resultExcerpt: '',
    });
    const excerptSessionId = await createActivitySession(bob.user.id, 'failure with excerpt', 'failed');
    const failedWithExcerpt = await insertSessionEventFor(excerptSessionId, bob.user.id, 'session.completed', {
      status: 'failed',
      resultExcerpt: 'The provider timed out.',
    });
    const crashedSessionId = await createActivitySession(bob.user.id, 'crashed run', 'failed');
    const crash = await insertSessionEventFor(crashedSessionId, bob.user.id, 'session.status_changed', {
      status: 'failed',
    });

    const body = await activity(bob.cookie);

    expect(body.items.map((item: any) => [item.kind, Number(item.eventId)])).toEqual([
      ['session_failed', crash],
      ['session_failed', failedWithExcerpt],
      ['session_failed', terminalCompleted],
    ]);
    expect(body.items.map((item: any) => Number(item.eventId))).not.toContain(duplicateStatus);
    expect(body.items.find((item: any) => Number(item.eventId) === terminalCompleted)).toMatchObject({
      snippet: 'No result — the run ended with an error.',
      sessionTitle: 'terminal failure',
      sessionStatus: 'failed',
    });
    expect(body.items.find((item: any) => Number(item.eventId) === crash)).toMatchObject({
      snippet: 'The run crashed before finishing.',
      sessionTitle: 'crashed run',
      sessionStatus: 'failed',
    });
    expect(body.items.find((item: any) => Number(item.eventId) === failedWithExcerpt)).toMatchObject({
      snippet: 'The provider timed out.',
    });
  });

  it('resolves id-mention tokens in snippets to display names', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    await post(alice.cookie, fx.channelId, `<@${bob.user.id}> this run failed — worth a retry?`);
    const ghost = '00000000-0000-4000-8000-000000000000';
    await post(alice.cookie, fx.channelId, `@bob also pinging <@${ghost}> who does not exist`);

    const body = await activity(bob.cookie);

    const resolved = body.items.find((item: any) => item.snippet.includes('worth a retry'));
    expect(resolved.snippet).toBe('@Bob this run failed — worth a retry?');
    // Unknown ids keep the raw token rather than inventing a name.
    const unresolved = body.items.find((item: any) => item.snippet.includes('does not exist'));
    expect(unresolved.snippet).toContain(`<@${ghost}>`);
  });

  it('returns auth blocks and marks truncated snippets with an ellipsis', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const authSessionId = await createActivitySession(bob.user.id, 'provider reconnect', 'queued');
    const auth = await insertSessionEventFor(authSessionId, bob.user.id, 'session.provider_auth_required', {
      provider: 'claude',
      reason: 'invalid_token',
    });
    const longText = `@bob ${'x'.repeat(160)}`;
    const mention = await post(alice.cookie, fx.channelId, longText);

    const body = await activity(bob.cookie);

    expect(body.items.find((item: any) => Number(item.eventId) === auth)).toMatchObject({
      kind: 'agent_auth',
      snippet: 'Blocked until you reconnect claude.',
      sessionTitle: 'provider reconnect',
      sessionStatus: 'queued',
    });
    expect(body.items.find((item: any) => Number(item.eventId) === mention.id)).toMatchObject({
      kind: 'mention',
      snippet: `${longText.slice(0, 139)}…`,
    });
  });

  it('returns thread replies to thread participants and leaves mentioned replies to the mention feed', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const cara = await login('cara', 'Cara');
    const dave = await login('dave', 'Dave');
    const root = await post(alice.cookie, fx.channelId, 'thread root');
    await post(bob.cookie, fx.channelId, 'earlier reply', root.id);
    const reply = await post(cara.cookie, fx.channelId, 'ordinary thread reply', root.id);
    const mentionedReply = await post(cara.cookie, fx.channelId, 'thread ping @bob', root.id);
    const dm = await createDm(alice.cookie, bob.user.id);
    const dmRoot = await post(alice.cookie, dm.id, 'DM thread root');
    const dmReply = await post(bob.cookie, dm.id, 'DM thread reply', dmRoot.id);

    const aliceItems = (await activity(alice.cookie)).items;
    const bobItems = (await activity(bob.cookie)).items;
    const daveItems = (await activity(dave.cookie)).items;

    expect(aliceItems.find((item: any) => Number(item.eventId) === reply.id)).toMatchObject({
      kind: 'thread_reply',
      snippet: 'ordinary thread reply',
      actorId: cara.user.id,
    });
    expect(bobItems.find((item: any) => Number(item.eventId) === reply.id)).toMatchObject({
      kind: 'thread_reply',
    });
    expect(bobItems.filter((item: any) => Number(item.eventId) === mentionedReply.id)).toEqual([
      expect.objectContaining({ kind: 'mention' }),
    ]);
    expect(aliceItems.filter((item: any) => Number(item.eventId) === dmReply.id)).toEqual([
      expect.objectContaining({ kind: 'thread_reply' }),
    ]);
    expect(daveItems.map((item: any) => Number(item.eventId))).not.toContain(reply.id);
  });

  it('surfaces reactions to my messages, channel invites, and seat requests as ambient history', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const mine = await post(bob.cookie, fx.channelId, 'react to this');
    const reactRes = await app.inject({
      method: 'POST',
      url: `/api/messages/${mine.id}/reactions`,
      headers: { cookie: alice.cookie },
      payload: { emoji: '🔥', action: 'add' },
    });
    expect(reactRes.statusCode).toBe(200);

    const sessionId = await createActivitySession(bob.user.id, 'seat session');
    const seat = await insertSessionEventFor(sessionId, alice.user.id, 'session.seat_requested', {
      by: alice.user.id,
    });
    const inviteId = await seedEvent(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      type: 'channel.member_joined',
      actorId: alice.user.id,
      payload: { userId: bob.user.id, displayName: 'Bob' },
    });

    const items = (await activity(bob.cookie)).items;
    const reaction = items.find((item: any) => item.kind === 'reaction');
    expect(reaction).toMatchObject({ actorId: alice.user.id, attention: false });
    expect(reaction.snippet).toContain('🔥');
    expect(reaction.snippet).toContain('react to this');
    expect(items.find((item: any) => Number(item.eventId) === seat)).toMatchObject({
      kind: 'seat_request',
      sessionTitle: 'seat session',
      attention: false,
    });
    expect(items.find((item: any) => Number(item.eventId) === inviteId)).toMatchObject({
      kind: 'channel_invite',
      actorId: alice.user.id,
      attention: false,
    });
    // Nobody is alerted about their own reactions or other people's invites.
    const aliceItems = (await activity(alice.cookie)).items;
    expect(aliceItems.find((item: any) => item.kind === 'reaction')).toBeUndefined();
  });

  it('keeps the counts route equivalent to the feed and counts a pending seat request as attention', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    await post(alice.cookie, fx.channelId, 'ping @bob');

    const questionSessionId = await createActivitySession(bob.user.id, 'question session');
    await pool.query(`UPDATE sessions SET pending_question = $2::jsonb WHERE id = $1`, [
      questionSessionId,
      JSON.stringify({ questionId: 'q-counts', turnId: 'turn-counts', questions: [], eventId: 1 }),
    ]);
    await insertSessionEventFor(questionSessionId, bob.user.id, 'session.question_requested', {
      questions: [{ id: 'q-counts', question: 'Ship it?' }],
    });

    const seatSessionId = await createActivitySession(bob.user.id, 'seat session');
    await pool.query('INSERT INTO seat_requests (session_id, user_id) VALUES ($1, $2)', [seatSessionId, alice.user.id]);
    const seatEventId = await insertSessionEventFor(seatSessionId, alice.user.id, 'session.seat_requested', {
      by: alice.user.id,
    });

    const feed = await activity(bob.cookie);
    const counts = await activityCounts(bob.cookie);

    expect(counts).toMatchObject({
      attention: feed.counts.attention,
      unread: feed.counts.unread,
      needsYou: feed.counts.needsYou,
      running: feed.counts.running,
      toReview: feed.counts.toReview,
      channelCounts: feed.channelCounts,
    });
    expect(counts.attention).toBe(2);
    expect(counts.needsYou).toBe(2);
    expect(feed.items.find((item: any) => Number(item.eventId) === seatEventId)).toMatchObject({
      kind: 'seat_request',
      attention: true,
    });
  });

  it('returns an ETag and accepts strong and weak conditional count requests', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const initial = await app.inject({
      method: 'GET',
      url: '/api/activity/counts',
      headers: { cookie: bob.cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(initial.headers['cache-control']).toBe('private, no-cache');

    for (const ifNoneMatch of [initial.headers.etag!, `W/${initial.headers.etag}`]) {
      const notModified = await app.inject({
        method: 'GET',
        url: '/api/activity/counts',
        headers: { cookie: bob.cookie, 'if-none-match': ifNoneMatch },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body).toBe('');
    }

    await post(alice.cookie, fx.channelId, 'new ping @bob');
    const changed = await app.inject({
      method: 'GET',
      url: '/api/activity/counts',
      headers: { cookie: bob.cookie, 'if-none-match': initial.headers.etag! },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(initial.headers.etag);
    expect(changed.json().unread).toBe(1);
  });

  it('keeps muted-channel items in history but out of counts and attention', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const sessionId = await createActivitySession(bob.user.id, 'muted blocked session', 'queued');
    await pool.query(`UPDATE sessions SET provider_auth_required = '{"provider":"claude"}'::jsonb WHERE id = $1`, [
      sessionId,
    ]);
    const auth = await insertSessionEventFor(sessionId, bob.user.id, 'session.provider_auth_required', {
      provider: 'claude',
    });
    const mention = await post(alice.cookie, fx.channelId, 'ping @bob while muted');

    const before = await activity(bob.cookie);
    expect(before.counts.attention).toBeGreaterThanOrEqual(1);
    expect(before.counts.unread).toBeGreaterThanOrEqual(2);

    const muteRes = await app.inject({
      method: 'POST',
      url: `/api/channels/${fx.channelId}/mute`,
      headers: { cookie: bob.cookie },
      payload: { muted: true },
    });
    expect(muteRes.statusCode).toBe(200);

    const after = await activity(bob.cookie);
    // Quiet, not hidden: the rows remain…
    expect(after.items.find((item: any) => Number(item.eventId) === mention.id)).toMatchObject({
      kind: 'mention',
      muted: true,
    });
    expect(after.items.find((item: any) => Number(item.eventId) === auth)).toMatchObject({
      kind: 'agent_auth',
      muted: true,
      attention: false,
    });
    // …but they no longer demand anything.
    expect(after.counts).toMatchObject({ attention: 0, unread: 0 });

    await app.inject({
      method: 'POST',
      url: `/api/channels/${fx.channelId}/mute`,
      headers: { cookie: bob.cookie },
      payload: { muted: false },
    });
  });

  it('does not leak stale private-channel mentions after membership changes', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const secret = await createPrivate(alice.cookie, 'secret');
    await addMember(alice.cookie, secret.id, bob.user.id);
    const mention = await post(alice.cookie, secret.id, 'private ping @bob');

    expect((await activity(bob.cookie)).items.map((item: any) => Number(item.eventId))).toContain(mention.id);

    await leaveChannel(bob.cookie, secret.id);
    expect((await activity(bob.cookie)).items.map((item: any) => Number(item.eventId))).not.toContain(mention.id);
  });

  it('shows missed and declined direct calls only to members who never joined', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const cara = await login('cara', 'Cara');
    const dm = await createDm(alice.cookie, bob.user.id);
    const missed = await insertEndedCallActivity(dm.id, alice.user.id, [alice.user.id]);
    const declined = await insertEndedCallActivity(dm.id, alice.user.id, [alice.user.id], [bob.user.id]);
    const gdm = await createGdm(alice.cookie, [bob.user.id, cara.user.id]);
    const groupCall = await insertEndedCallActivity(gdm.id, alice.user.id, [alice.user.id, bob.user.id]);

    const bobItems = (await activity(bob.cookie)).items;
    expect(bobItems.find((item: any) => Number(item.eventId) === missed.eventId)).toMatchObject({
      kind: 'missed_call',
      actorId: alice.user.id,
      actorName: 'Alice',
      snippet: 'You missed a call.',
      sessionId: null,
      sessionTitle: null,
      sessionStatus: null,
      attention: false,
    });
    expect(bobItems.find((item: any) => Number(item.eventId) === declined.eventId)).toMatchObject({
      kind: 'call_declined',
      actorId: alice.user.id,
      snippet: 'You declined this call.',
      attention: false,
    });
    expect(bobItems.map((item: any) => Number(item.eventId))).not.toContain(groupCall.eventId);

    const caraItems = (await activity(cara.cookie)).items;
    expect(caraItems.find((item: any) => Number(item.eventId) === groupCall.eventId)).toMatchObject({
      kind: 'missed_call',
      snippet: 'You missed a call.',
      attention: false,
    });

    const aliceItems = (await activity(alice.cookie)).items;
    for (const eventId of [missed.eventId, declined.eventId, groupCall.eventId]) {
      expect(aliceItems.map((item: any) => Number(item.eventId))).not.toContain(eventId);
    }
  });

  it('returns read-state metadata and derives attention from current session state', async () => {
    const bob = await login('bob', 'Bob');
    const questionSessionId = await createActivitySession(bob.user.id, 'waiting for an answer');
    await pool.query(`UPDATE sessions SET pending_question = $2::jsonb WHERE id = $1`, [
      questionSessionId,
      JSON.stringify({ questionId: 'q-1' }),
    ]);
    const question = await insertSessionEventFor(questionSessionId, bob.user.id, 'session.question_requested', {
      questions: [{ id: 'q-1', question: 'Ship it?' }],
    });

    const authSessionId = await createActivitySession(bob.user.id, 'reconnect provider', 'queued');
    await pool.query(`UPDATE sessions SET provider_auth_required = $2::jsonb WHERE id = $1`, [
      authSessionId,
      JSON.stringify({ provider: 'claude' }),
    ]);
    const auth = await insertSessionEventFor(authSessionId, bob.user.id, 'session.provider_auth_required', {
      provider: 'claude',
    });

    const failedSessionId = await createActivitySession(bob.user.id, 'failed run', 'failed');
    const failed = await insertSessionEventFor(failedSessionId, bob.user.id, 'session.status_changed', {
      status: 'failed',
    });

    const initial = await activity(bob.cookie);
    expect(initial).toMatchObject({
      lastReadEventId: '0',
      counts: { attention: 3, unread: 3 },
    });
    expect(initial.items.find((item: any) => Number(item.eventId) === question)).toMatchObject({
      sessionId: questionSessionId,
      attention: true,
    });
    expect(initial.items.find((item: any) => Number(item.eventId) === auth)).toMatchObject({
      sessionId: authSessionId,
      attention: true,
    });
    expect(initial.items.find((item: any) => Number(item.eventId) === failed)).toMatchObject({
      sessionId: failedSessionId,
      attention: true,
    });

    const read = await app.inject({
      method: 'POST',
      url: '/api/activity/read',
      headers: { cookie: bob.cookie },
      payload: { lastReadEventId: failed + 10_000 },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ lastReadEventId: String(failed), unreadExceptionIds: [] });

    // Read cursors only move forward. A slower tab cannot make the failure
    // unread again after this tab has acknowledged it.
    const staleRead = await app.inject({
      method: 'POST',
      url: '/api/activity/read',
      headers: { cookie: bob.cookie },
      payload: { lastReadEventId: question },
    });
    expect(staleRead.statusCode).toBe(200);
    expect(staleRead.json()).toMatchObject({ lastReadEventId: String(failed), unreadExceptionIds: [] });

    const acknowledged = await activity(bob.cookie);
    expect(acknowledged.counts).toMatchObject({ attention: 2, unread: 0 });
    expect(acknowledged.items.find((item: any) => Number(item.eventId) === failed)).toMatchObject({ attention: false });

    await pool.query('UPDATE sessions SET pending_question = NULL WHERE id = $1', [questionSessionId]);
    await pool.query('UPDATE sessions SET provider_auth_required = NULL WHERE id = $1', [authSessionId]);
    const cleared = await activity(bob.cookie);
    expect(cleared.counts).toMatchObject({ attention: 0, unread: 0 });
    expect(cleared.items.find((item: any) => Number(item.eventId) === question)).toMatchObject({ attention: false });
    expect(cleared.items.find((item: any) => Number(item.eventId) === auth)).toMatchObject({ attention: false });
  });

  it('moves a pending question to history when its session has already left an active state', async () => {
    const bob = await login('bob', 'Bob');
    const sessionId = await createActivitySession(bob.user.id, 'already ended', 'completed');
    await pool.query(`UPDATE sessions SET pending_question = $2::jsonb WHERE id = $1`, [
      sessionId,
      JSON.stringify({ questionId: 'q-ended' }),
    ]);
    const question = await insertSessionEventFor(sessionId, bob.user.id, 'session.question_requested', {
      questions: [{ id: 'q-ended', question: 'Should not stay pinned?' }],
    });

    const body = await activity(bob.cookie);
    expect(body.counts).toMatchObject({ attention: 0, unread: 1 });
    expect(body.items.find((item: any) => Number(item.eventId) === question)).toMatchObject({
      sessionId,
      attention: false,
    });
  });

  it('returns true agent-work and review counts, scoped by channel', async () => {
    const bob = await login('bob', 'Bob');
    const privateChannel = await createPrivate(bob.cookie, 'private agent work');
    const needsQuestion = await createActivitySession(bob.user.id, 'question', 'running');
    await pool.query(`UPDATE sessions SET pending_question = $2::jsonb WHERE id = $1`, [
      needsQuestion,
      JSON.stringify({ questionId: 'q-1', turnId: 'turn-1', questions: [], eventId: 1 }),
    ]);
    const needsAuth = await createActivitySession(bob.user.id, 'auth', 'queued', privateChannel.id);
    await pool.query(`UPDATE sessions SET provider_auth_required = $2::jsonb WHERE id = $1`, [
      needsAuth,
      JSON.stringify({ provider: 'codex', userId: bob.user.id, reason: 'missing_token' }),
    ]);
    await createActivitySession(bob.user.id, 'running');
    const archivedRunning = await createActivitySession(bob.user.id, 'archived running');
    await pool.query('UPDATE sessions SET archived_at = now() WHERE id = $1', [archivedRunning]);

    const reviewedSession = await createActivitySession(bob.user.id, 'review me', 'completed');
    await insertSessionEventFor(reviewedSession, bob.user.id, 'session.completed', { status: 'completed' });
    const latestReview = await insertSessionEventFor(reviewedSession, bob.user.id, 'session.completed', {
      status: 'completed',
    });
    const archivedReview = await createActivitySession(bob.user.id, 'archived review', 'completed');
    await insertSessionEventFor(archivedReview, bob.user.id, 'session.completed', { status: 'completed' });
    await pool.query('UPDATE sessions SET archived_at = now() WHERE id = $1', [archivedReview]);

    const initial = await activity(bob.cookie);
    expect(initial.counts).toMatchObject({ needsYou: 2, running: 1, toReview: 1 });
    expect(initial.channelCounts).toEqual({
      [fx.channelId]: { needsYou: 1, running: 1, toReview: 1 },
      [privateChannel.id]: { needsYou: 1, running: 0, toReview: 0 },
    });

    const markAll = await app.inject({
      method: 'POST',
      url: '/api/activity/read',
      headers: { cookie: bob.cookie },
      payload: { lastReadEventId: latestReview },
    });
    expect(markAll.statusCode).toBe(200);
    expect((await activity(bob.cookie)).counts).toMatchObject({ toReview: 0 });

    const markUnread = await app.inject({
      method: 'POST',
      url: '/api/activity/read',
      headers: { cookie: bob.cookie },
      payload: { markUnreadEventId: latestReview },
    });
    expect(markUnread.statusCode).toBe(200);
    expect((await activity(bob.cookie)).counts).toMatchObject({ toReview: 1 });
  });

  it('marks every terminal item in one session reviewed without touching other sessions', async () => {
    const bob = await login('bob', 'Bob');
    const target = await createActivitySession(bob.user.id, 'review target', 'completed');
    const first = await insertSessionEventFor(target, bob.user.id, 'session.completed', { status: 'completed' });
    const other = await createActivitySession(bob.user.id, 'leave unread', 'failed');
    const otherEvent = await insertSessionEventFor(other, bob.user.id, 'session.completed', { status: 'failed' });
    const second = await insertSessionEventFor(target, bob.user.id, 'session.completed', { status: 'completed' });

    const read = await app.inject({
      method: 'POST',
      url: `/api/activity/sessions/${target}/read`,
      headers: { cookie: bob.cookie },
    });
    expect(read.statusCode).toBe(204);
    const after = await activity(bob.cookie);
    expect(after.items.find((item: any) => Number(item.eventId) === first)).toMatchObject({ unread: false });
    expect(after.items.find((item: any) => Number(item.eventId) === second)).toMatchObject({ unread: false });
    expect(after.items.find((item: any) => Number(item.eventId) === otherEvent)).toMatchObject({ unread: true });
    expect(after.counts).toMatchObject({ toReview: 1 });

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/activity/sessions/${target}/read`,
      headers: { cookie: bob.cookie },
    });
    expect(repeated.statusCode).toBe(204);
  });

  it('does not let a non-member mark a private session reviewed', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const secret = await createPrivate(alice.cookie, 'review secret');
    const sessionId = await createActivitySession(alice.user.id, 'private review', 'completed', secret.id);
    await insertSessionEventFor(sessionId, alice.user.id, 'session.completed', { status: 'completed' }, secret.id);

    const denied = await app.inject({
      method: 'POST',
      url: `/api/activity/sessions/${sessionId}/read`,
      headers: { cookie: bob.cookie },
    });
    expect(denied.statusCode).toBe(404);
  });

  it('rejects non-numeric activity cursors', async () => {
    const bob = await login('bob', 'Bob');
    const res = await app.inject({
      method: 'POST',
      url: '/api/activity/read',
      headers: { cookie: bob.cookie },
      payload: { lastReadEventId: 'not-an-event-id' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request' });
  });

  it('supports per-item mark read/unread via watermark exceptions', async () => {
    const bob = await login('bob', 'Bob');
    const alice = await login('alice', 'Alice');
    await post(alice.cookie, fx.channelId, 'hello @bob from the public channel');

    const before = await activity(bob.cookie);
    expect(before.counts.unread).toBeGreaterThanOrEqual(1);
    const target = before.items.find((item: { kind: string }) => item.kind === 'mention');
    expect(target).toBeTruthy();
    const targetId = Number(target.eventId);
    const newestId = Math.max(...before.items.map((item: { eventId: string }) => Number(item.eventId)));

    const markAll = await app.inject({
      method: 'POST',
      url: '/api/activity/read',
      headers: { cookie: bob.cookie },
      payload: { lastReadEventId: newestId },
    });
    expect(markAll.statusCode).toBe(200);
    expect(markAll.json()).toMatchObject({ lastReadEventId: String(newestId), unreadExceptionIds: [] });

    const markUnread = await app.inject({
      method: 'POST',
      url: '/api/activity/read',
      headers: { cookie: bob.cookie },
      payload: { markUnreadEventId: targetId },
    });
    expect(markUnread.statusCode).toBe(200);
    expect(markUnread.json().unreadExceptionIds.map(String)).toContain(String(targetId));

    const afterUnread = await activity(bob.cookie);
    expect(afterUnread.counts.unread).toBeGreaterThanOrEqual(1);
    expect(afterUnread.items.find((item: { eventId: string }) => Number(item.eventId) === targetId)).toMatchObject({
      unread: true,
    });
    expect(afterUnread.unreadExceptionIds.map(String)).toContain(String(targetId));

    const markRead = await app.inject({
      method: 'POST',
      url: '/api/activity/read',
      headers: { cookie: bob.cookie },
      payload: { markReadEventId: targetId },
    });
    expect(markRead.statusCode).toBe(200);
    expect(markRead.json().unreadExceptionIds.map(String)).not.toContain(String(targetId));

    const afterRead = await activity(bob.cookie);
    expect(afterRead.items.find((item: { eventId: string }) => Number(item.eventId) === targetId)).toMatchObject({
      unread: false,
    });
  });
});

async function login(handle: string, displayName: string): Promise<Login> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  const user = res.json().user;
  await addWorkspaceMember(pool, fx.workspaceId, user.id);
  return { cookie: res.headers['set-cookie'] as string, user };
}

async function activity(cookie: string, cursor?: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/activity${cursor ? `?cursor=${cursor}` : ''}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function activityCounts(cookie: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/activity/counts',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function createDm(cookie: string, userId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/dms',
    headers: { cookie },
    payload: { userId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().channel;
}

async function createGdm(cookie: string, userIds: string[]) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/dms',
    headers: { cookie },
    payload: { userIds },
  });
  expect(res.statusCode).toBe(201);
  return res.json().channel;
}

async function createPrivate(cookie: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/channels',
    headers: { cookie },
    payload: { name, private: true },
  });
  expect(res.statusCode).toBe(201);
  return res.json().channel;
}

async function addMember(cookie: string, channelId: string, userId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/channels/${channelId}/members`,
    headers: { cookie },
    payload: { userId },
  });
  expect(res.statusCode).toBe(201);
}

async function leaveChannel(cookie: string, channelId: string) {
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/channels/${channelId}/members/me`,
    headers: { cookie },
    payload: { opId: randomUUID() },
  });
  expect(res.statusCode).toBe(200);
}

async function post(cookie: string, channelId: string, text: string, threadRootEventId?: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { cookie },
    payload: { channelId, text, clientMsgId: randomUUID(), ...(threadRootEventId ? { threadRootEventId } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json().event as { id: number; channelId: string };
}

async function insertEndedCallActivity(
  channelId: string,
  initiatorId: string,
  participantIds: string[],
  declinedIds: string[] = [],
): Promise<{ callId: string; eventId: number }> {
  const callId = randomUUID();
  const startedAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO calls (id, workspace_id, channel_id, initiator_id, room, status, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, 'ended', $6, now())`,
    [callId, fx.workspaceId, channelId, initiatorId, `call:${callId}`, startedAt],
  );
  for (const userId of participantIds) {
    await pool.query('INSERT INTO call_participants (call_id, user_id, left_at) VALUES ($1, $2, now())', [
      callId,
      userId,
    ]);
  }
  for (const userId of declinedIds) {
    await pool.query('INSERT INTO call_declines (call_id, user_id) VALUES ($1, $2)', [callId, userId]);
  }
  const eventId = await seedEvent(pool, {
    workspaceId: fx.workspaceId,
    channelId,
    type: 'call.ended',
    actorId: initiatorId,
    payload: {
      callId,
      initiatorId,
      startedAt,
      answered: participantIds.some((userId) => userId !== initiatorId),
    },
  });
  return { callId, eventId };
}

async function insertSessionEvent(userId: string, type: string, payload: Record<string, unknown>): Promise<number> {
  const sessionId = await createActivitySession(userId);
  return insertSessionEventFor(sessionId, userId, type, payload);
}

async function createActivitySession(
  userId: string,
  title = 'activity test',
  status = 'running',
  channelId = fx.channelId,
): Promise<string> {
  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by, driver_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING id`,
    [fx.workspaceId, channelId, `test:${randomUUID()}`, title, status, userId],
  );
  return session.rows[0]!.id;
}

async function insertSessionEventFor(
  sessionId: string,
  userId: string,
  type: string,
  payload: Record<string, unknown>,
  channelId = fx.channelId,
): Promise<number> {
  return seedEvent(pool, {
    workspaceId: fx.workspaceId,
    channelId,
    type,
    actorId: userId,
    payload: { ...payload, sessionId },
  });
}
