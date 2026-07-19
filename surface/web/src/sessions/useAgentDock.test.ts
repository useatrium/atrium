import { describe, expect, it } from 'vitest';
import type { Channel } from '@atrium/surface-client';
import type { Session } from './types';
import { agentDockCounts, agentDockGroups } from './useAgentDock';

const NOW = Date.parse('2026-07-18T12:00:00.000Z');

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    channelId: 'channel-1',
    threadRootEventId: null,
    title: 'Agent session',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'user-1',
    driverId: 'user-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/s/session-1',
    ...overrides,
  };
}

const channels = [
  { id: 'channel-1', name: 'one' },
  { id: 'channel-2', name: 'two' },
] as Channel[];

describe('agentDockGroups', () => {
  it('puts longest-blocked needs-you sessions ahead of channel work', () => {
    const groups = agentDockGroups(
      {
        live: session({ id: 'live', title: 'Live' }),
        newerQuestion: session({
          id: 'newer-question',
          pendingQuestion: { questionId: 'q2', questions: [], askedAt: '2026-07-18T11:00:00.000Z' },
        }),
        olderQuestion: session({
          id: 'older-question',
          pendingQuestion: { questionId: 'q1', questions: [], askedAt: '2026-07-18T09:00:00.000Z' },
        }),
      },
      { now: NOW, channels },
    );

    expect(groups.map((group) => group.kind)).toEqual(['needs', 'channel']);
    expect(groups[0]?.sessions.map((row) => row.id)).toEqual(['older-question', 'newer-question']);
  });

  it('groups live work by channel with the active channel first', () => {
    const groups = agentDockGroups(
      {
        other: session({ id: 'other', channelId: 'channel-2' }),
        active: session({ id: 'active', channelId: 'channel-1' }),
      },
      { activeChannelId: 'channel-1', now: NOW, channels },
    );
    expect(groups.map((group) => group.channelId)).toEqual(['channel-1', 'channel-2']);
  });

  it('puts terminal sessions in recent history', () => {
    const groups = agentDockGroups(
      { done: session({ id: 'done', status: 'completed', completedAt: '2026-07-18T11:30:00.000Z' }) },
      { now: NOW },
    );
    expect(groups).toMatchObject([{ kind: 'recent', sessions: [{ id: 'done' }] }]);
  });

  it('keeps a failed session in needs-you (matching the count), not history', () => {
    const groups = agentDockGroups(
      { failed: session({ id: 'failed', status: 'failed', completedAt: '2026-07-18T11:30:00.000Z' }) },
      { now: NOW },
    );
    expect(groups.map((group) => group.kind)).toEqual(['needs']);
    expect(groups[0]?.sessions.map((row) => row.id)).toEqual(['failed']);
  });
});

describe('agentDockCounts', () => {
  it('does not double-count a failed needs-you session as review', () => {
    expect(agentDockCounts({ failed: session({ id: 'failed', status: 'failed' }) })).toEqual({
      needsYou: 1,
      live: 0,
      review: 0,
    });
  });

  it('scopes every count bucket to sessions driven by the requested viewer', () => {
    const sessions = {
      myQuestion: session({
        id: 'my-question',
        driverId: 'viewer-1',
        pendingQuestion: { questionId: 'q1', questions: [], askedAt: '2026-07-18T11:00:00.000Z' },
      }),
      theirQuestion: session({
        id: 'their-question',
        spawnedBy: 'viewer-2',
        driverId: null,
        pendingQuestion: { questionId: 'q2', questions: [], askedAt: '2026-07-18T11:00:00.000Z' },
      }),
      myLive: session({ id: 'my-live', driverId: 'viewer-1' }),
      theirReview: session({ id: 'their-review', driverId: 'viewer-2', status: 'completed' }),
    };

    expect(agentDockCounts(sessions)).toEqual({ needsYou: 2, live: 1, review: 1 });
    expect(agentDockCounts(sessions, { mineOnly: 'viewer-1' })).toEqual({ needsYou: 1, live: 1, review: 0 });
    expect(agentDockCounts(sessions, { mineOnly: 'viewer-2' })).toEqual({ needsYou: 1, live: 0, review: 1 });
  });
});
