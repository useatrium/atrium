import { describe, expect, it } from 'vitest';
import { applySessionEvent } from '../src/sessions';
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
});
