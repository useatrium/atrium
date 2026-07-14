// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@atrium/surface-client';
import { getSessionNavigationCounts } from '../app/(app)/(tabs)/_layout';

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
vi.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));
vi.mock('../src/lib/chat', () => ({ useChat: vi.fn() }));

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    channelId: 'channel-1',
    threadRootEventId: 1,
    title: 'Review the change',
    status: 'running',
    harness: 'codex',
    branch: null,
    repos: null,
    spawnedBy: 'user-1',
    driverId: 'user-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    pendingQuestion: null,
    providerAuthRequired: null,
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-11T00:00:00.000Z',
    completedAt: null,
    lastEventId: 1,
    permalink: '/session/session-1',
    ...overrides,
    archivedAt: overrides.archivedAt ?? null,
    pinned: overrides.pinned ?? false,
  };
}

describe('mobile tab attention semantics', () => {
  it('shows normal running sessions as live without badging Attention', () => {
    expect(getSessionNavigationCounts({ running: session() })).toEqual({ live: 1, attention: 0 });
  });

  it('badges actionable live states', () => {
    const asking = session({
      id: 'asking',
      pendingQuestion: { questionId: 'question-1', questions: [] },
    });
    const authenticating = session({
      id: 'authenticating',
      providerAuthRequired: {
        provider: 'codex',
        userId: 'user-1',
        reason: 'missing_token',
        message: 'Connect Codex',
        at: '2026-07-11T00:01:00.000Z',
      },
    });
    const failed = session({ id: 'failed', status: 'failed' });

    expect(getSessionNavigationCounts({ asking, authenticating, failed })).toEqual({ live: 2, attention: 3 });
  });

  it('does not announce or badge archived sessions', () => {
    const archivedRunning = session({ id: 'archived-running', archivedAt: '2026-07-11T01:00:00.000Z' });
    const archivedFailed = session({
      id: 'archived-failed',
      status: 'failed',
      archivedAt: '2026-07-11T01:01:00.000Z',
    });
    const visibleRunning = session({ id: 'visible-running' });

    expect(getSessionNavigationCounts({ archivedRunning, archivedFailed, visibleRunning })).toEqual({
      live: 1,
      attention: 0,
    });
  });
});
