import { describe, expect, it } from 'vitest';
import {
  applySessionActivity,
  applySessionEvent,
  deriveSessionGlance,
  isArchivedSession,
  isTerminalSessionStatus,
  sessionFromWire,
} from '../src/sessions';
import type { Session } from '../src/sessions';
import type { WireEvent } from '../src/timeline';

const alice = { id: 'u-alice', handle: 'alice', displayName: 'Alice' };

function spawned(payload: Record<string, unknown>): WireEvent {
  return {
    id: 1,
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    type: 'session.spawned',
    actorId: alice.id,
    payload: { sessionId: 'sess-1', title: 'task', by: alice.id, ...payload },
    createdAt: new Date(1000).toISOString(),
    author: alice,
  };
}

function optimistic(over: Partial<Session>): Record<string, Session> {
  return {
    'sess-1': {
      id: 'sess-1',
      workspaceId: '',
      channelId: 'ch-1',
      threadRootEventId: null,
      title: 'task',
      status: 'spawning',
      harness: 'claude-code',
      spawnedBy: alice.id,
      driverId: null,
      pendingSeatRequests: [],
      suggestions: [],
      answerProposals: [],
      seatEvents: [],
      costUsd: 0,
      resultText: null,
      createdAt: new Date(1000).toISOString(),
      completedAt: null,
      archivedAt: null,
      pinned: false,
      lastEventId: 0,
      permalink: '/s/sess-1',
      ...over,
    },
  };
}

describe('applySessionEvent repo/branch fold', () => {
  it('reads repo/branch from a fresh session.spawned event', () => {
    const s = applySessionEvent({}, spawned({ repo: 'acme/app', branch: 'dev' }));
    expect(s['sess-1']).toMatchObject({ repo: 'acme/app', branch: 'dev' });
  });

  it('defaults to null when the spawned event omits them', () => {
    const s = applySessionEvent({}, spawned({}));
    expect(s['sess-1']).toMatchObject({ repo: null, branch: null });
  });

  it('fills repo/branch from the event when the optimistic row lacked them', () => {
    const s = applySessionEvent(optimistic({ repo: null, branch: null }), spawned({ repo: 'acme/app', branch: 'dev' }));
    expect(s['sess-1']).toMatchObject({ repo: 'acme/app', branch: 'dev' });
  });

  it('keeps the optimistic repo/branch when the event omits them', () => {
    const s = applySessionEvent(optimistic({ repo: 'acme/app', branch: 'dev' }), spawned({}));
    expect(s['sess-1']).toMatchObject({ repo: 'acme/app', branch: 'dev' });
  });

  it('preserves GitHub identity metadata from session.spawned events', () => {
    const s = applySessionEvent(
      {},
      spawned({ githubIdentityMode: 'app_installation', providerConnectionId: 'github' }),
    );
    expect(s['sess-1']).toMatchObject({
      githubIdentityMode: 'app_installation',
      providerConnectionId: 'github',
    });
  });

  it('preserves GitHub identity metadata from session snapshots', () => {
    const s = sessionFromWire({
      id: 'sess-1',
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      title: 'task',
      status: 'running',
      harness: 'claude-code',
      spawnedBy: alice.id,
      driverId: null,
      githubIdentityMode: 'app_user',
      providerConnectionId: 'github',
      costUsd: 0,
      resultText: null,
      createdAt: new Date(1000).toISOString(),
      completedAt: null,
      archivedAt: null,
      pinned: false,
      lastEventId: 0,
      permalink: '/s/sess-1',
    });
    expect(s).toMatchObject({
      githubIdentityMode: 'app_user',
      providerConnectionId: 'github',
    });
  });
});

describe('applySessionEvent status fold', () => {
  function statusChanged(id: number, status: string): WireEvent {
    return {
      id,
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      type: 'session.status_changed',
      actorId: alice.id,
      payload: { sessionId: 'sess-1', status },
      createdAt: new Date(2000).toISOString(),
      author: alice,
    };
  }

  it('keeps a replayed spawn entity without claiming it is live', () => {
    const session = applySessionEvent({}, spawned({}))['sess-1']!;

    expect(session.status).toBe('unknown');
    expect(isTerminalSessionStatus(session.status)).toBe(true);
    expect(deriveSessionGlance(session, Date.now())).toMatchObject({
      label: 'Status unavailable',
      pulse: false,
    });
  });

  it('a replayed spawn does not fake a new turn and drop the question it is blocked on', () => {
    // Replay order for a session still waiting on a person: spawned (status
    // unknown) → question_requested → status_changed(running). The new-turn
    // clamp keys off "did this finish?", and `unknown` never did — treating it
    // as terminal here would clear pendingQuestion and hide real Needs-you work.
    const questionRequested: WireEvent = {
      id: 2,
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      type: 'session.question_requested',
      actorId: alice.id,
      payload: { sessionId: 'sess-1', questionId: 'q-1', questions: ['Ship it?'] },
      createdAt: new Date(1500).toISOString(),
      author: alice,
    };

    let sessions = applySessionEvent({}, spawned({}));
    sessions = applySessionEvent(sessions, questionRequested);
    expect(sessions['sess-1']!.pendingQuestion?.questionId).toBe('q-1');

    sessions = applySessionEvent(sessions, statusChanged(3, 'running'));

    expect(sessions['sess-1']!.status).toBe('running');
    expect(sessions['sess-1']!.pendingQuestion?.questionId).toBe('q-1');
  });

  it('never regresses within a turn (running does not fall back to queued)', () => {
    const s = applySessionEvent(optimistic({ status: 'running' }), statusChanged(5, 'queued'));
    expect(s['sess-1']!.status).toBe('running');
  });

  it('a follow-up turn reactivates a completed session (terminal → active)', () => {
    const s = applySessionEvent(
      optimistic({ status: 'completed', completedAt: new Date(1500).toISOString() }),
      statusChanged(6, 'running'),
    );
    expect(s['sess-1']!.status).toBe('running');
    expect(s['sess-1']!.completedAt).toBeNull();
  });

  it('re-completion after a follow-up turn stamps a fresh completedAt', () => {
    const reactivated = applySessionEvent(
      optimistic({ status: 'completed', completedAt: new Date(1500).toISOString() }),
      statusChanged(7, 'running'),
    );
    const done = applySessionEvent(reactivated, {
      id: 8,
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      type: 'session.completed',
      actorId: alice.id,
      payload: { sessionId: 'sess-1', status: 'completed' },
      createdAt: new Date(9000).toISOString(),
      author: alice,
    });
    expect(done['sess-1']!.status).toBe('completed');
    expect(done['sess-1']!.completedAt).toBe(new Date(9000).toISOString());
  });
});

describe('applySessionEvent archive fold', () => {
  it('sets and clears archive state from durable lifecycle events', () => {
    const archivedAt = '2026-07-11T12:00:00.000Z';
    const archived = applySessionEvent(optimistic({}), {
      id: 20,
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      type: 'session.archived',
      actorId: alice.id,
      payload: { sessionId: 'sess-1', archivedAt },
      createdAt: archivedAt,
      author: alice,
    });
    expect(archived['sess-1']!.archivedAt).toBe(archivedAt);
    expect(isArchivedSession(archived['sess-1']!)).toBe(true);

    const revived = applySessionEvent(archived, {
      id: 21,
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      type: 'session.unarchived',
      actorId: alice.id,
      payload: { sessionId: 'sess-1', archivedAt: null },
      createdAt: '2026-07-11T12:05:00.000Z',
      author: alice,
    });
    expect(revived['sess-1']!.archivedAt).toBeNull();
    expect(isArchivedSession(revived['sess-1']!)).toBe(false);
  });
});

describe('applySessionActivity', () => {
  it('stores the latest ephemeral activity without creating an unknown session', () => {
    const active = applySessionActivity(optimistic({}), 'sess-1', {
      summary: 'running tests: pnpm test',
      at: '2026-07-12T12:00:00.000Z',
    });
    expect(active['sess-1']?.latestActivity).toEqual({
      summary: 'running tests: pnpm test',
      at: '2026-07-12T12:00:00.000Z',
    });
    expect(applySessionActivity({}, 'unknown', { summary: 'reading README.md', at: 'now' })).toEqual({});
  });
});
