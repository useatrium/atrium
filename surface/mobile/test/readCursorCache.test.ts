import { initialAppState, type Channel } from '@atrium/surface-client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'test-id',
}));

vi.mock('expo-file-system/legacy', () => ({
  deleteAsync: vi.fn(),
}));

vi.mock('../src/lib/session', () => ({
  useSession: () => ({ invalidate: vi.fn() }),
}));

vi.mock('../src/lib/cacheSqlite', () => ({
  eventCache: {
    saveChannels: vi.fn(),
    saveSyncCursor: vi.fn(),
    loadSnapshot: vi.fn(),
    listOps: vi.fn(),
    enqueueEvents: vi.fn(),
    saveTimeline: vi.fn(),
  },
}));

vi.mock('../src/lib/theme', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/theme')>('../src/lib/theme');
  return {
    ...actual,
    useTheme: () => ({
      colors: actual.buildColors('light', 'indigo', false),
      reduceMotion: false,
      adoptPrefs: vi.fn(),
    }),
  };
});

vi.mock('../src/lib/useCall', () => ({
  useCall: () => ({
    refreshActiveCalls: vi.fn(),
  }),
}));

vi.mock('../src/lib/entryResolve', () => ({
  createArtifactContentResolver: () => vi.fn(),
  createEntryResolver: () => vi.fn(),
}));

import { channelsAfterReadCursorAdvance } from '../src/lib/chat';

function channel(id: string, lastReadEventId: number): Channel {
  return {
    id,
    workspaceId: 'w-1',
    kind: 'public',
    name: id,
    title: id,
    createdAt: '2026-07-02T12:00:00.000Z',
    latestEventId: 20,
    lastReadEventId,
    muted: false,
    memberCount: 2,
    members: [],
  } as unknown as Channel;
}

describe('channelsAfterReadCursorAdvance', () => {
  it('returns reducer-advanced channels for a monotonic cursor advance', () => {
    const state = {
      ...initialAppState,
      channels: [channel('c-1', 10), channel('c-2', 7)],
    };

    const channels = channelsAfterReadCursorAdvance(state, 'c-1', 15);

    expect(channels?.find((c) => c.id === 'c-1')?.lastReadEventId).toBe(15);
    expect(channels?.find((c) => c.id === 'c-2')?.lastReadEventId).toBe(7);
  });

  it('does not request a cache write for stale or same cursor values', () => {
    const state = {
      ...initialAppState,
      channels: [channel('c-1', 10)],
    };

    expect(channelsAfterReadCursorAdvance(state, 'c-1', 10)).toBeNull();
    expect(channelsAfterReadCursorAdvance(state, 'c-1', 4)).toBeNull();
    expect(channelsAfterReadCursorAdvance(state, 'missing', 12)).toBeNull();
  });
});
