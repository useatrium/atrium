import { describe, expect, it, vi } from 'vitest';
import type { AppAction, WireEvent } from '@atrium/surface-client';
import { hydrateCachedTimelines } from '../src/hydration';

function wire(id: number, channelId = 'ch-1'): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId,
    threadRootEventId: null,
    type: 'message.posted',
    actorId: 'u-1',
    payload: { text: `message ${id}` },
    createdAt: new Date(id * 1000).toISOString(),
    author: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
  };
}

describe('cached timeline hydration', () => {
  it('repairs a cached timeline whose last event is behind the persisted cursor', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const latest = { events: [wire(9)], hasMore: true };
    const fetchLatest = vi.fn(async () => latest);
    const onRepaired = vi.fn();

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events: [wire(4)], hasMore: false } },
      syncCursor: 8,
      dispatch,
      fetchLatest,
      onRepaired,
    });

    expect(fetchLatest).toHaveBeenCalledWith('ch-1');
    expect(dispatch).toHaveBeenCalledWith({
      type: 'history-reset',
      channelId: 'ch-1',
      events: latest.events,
      hasMore: latest.hasMore,
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'history-loaded' }),
    );
    expect(onRepaired).toHaveBeenCalledWith('ch-1', latest);
  });

  it('hydrates cached timelines directly when they are not behind the cursor', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const fetchLatest = vi.fn();
    const events = [wire(8)];

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events, hasMore: false } },
      syncCursor: 8,
      dispatch,
      fetchLatest,
    });

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: 'history-loaded',
      channelId: 'ch-1',
      events,
      hasMore: false,
    });
  });
});
