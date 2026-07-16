import type { AppAction, CachedTimeline, WireEvent } from '@atrium/surface-client';
import { eventIdFromTarget } from '@atrium/surface-client/handle';

interface HistoryPage {
  events: WireEvent[];
  hasMore: boolean;
  nextCursor?: number;
  readCursor?: number;
}

export function cachedTimelineLastEventId(timeline: CachedTimeline): number {
  return timeline.events.reduce((max, event) => Math.max(max, event.id), 0);
}

export function cachedTimelineNeedsCursorRepair(timeline: CachedTimeline, syncCursor: number): boolean {
  return syncCursor > 0 && cachedTimelineLastEventId(timeline) < syncCursor;
}

function targetEventId(event: WireEvent): number | null {
  const value = event.payload?.target;
  return typeof value === 'string' ? eventIdFromTarget(value) : null;
}

function isRowEvent(type: string): boolean {
  return (
    type === 'message.posted' ||
    type === 'session.spawned' ||
    type === 'session.replied' ||
    type === 'session.question_requested' ||
    type === 'session.question_answered' ||
    type === 'session.question_resolved'
  );
}

export function cachedTimelineNeedsStructuralRepair(timeline: CachedTimeline): boolean {
  const rowIds = new Set(
    timeline.events
      .filter((event) => (event.threadRootEventId == null || event.broadcast === true) && isRowEvent(event.type))
      .map((event) => event.id),
  );
  return timeline.events.some((event) => {
    const targetId = targetEventId(event);
    return targetId != null && !rowIds.has(targetId);
  });
}

export async function hydrateCachedTimelines({
  timelines,
  syncCursor,
  dispatch,
  firstChannelId,
  fetchLatest,
  fetchDelta,
  isDisposed,
  onRepaired,
  onRepairFailed,
  onDeltaLoaded,
  onDeltaFailed,
}: {
  timelines: Record<string, CachedTimeline>;
  syncCursor: number;
  dispatch: (action: AppAction) => void;
  /** Hydrate this channel before the rest — it's the one on screen, and its
   * divider landing defers until its warm delta settles. */
  firstChannelId?: string;
  fetchLatest: (channelId: string) => Promise<HistoryPage>;
  fetchDelta: (channelId: string, afterId: number) => Promise<HistoryPage>;
  isDisposed?: () => boolean;
  onRepaired?: (channelId: string, page: HistoryPage) => void;
  onRepairFailed?: (channelId: string, err: unknown) => void;
  onDeltaLoaded?: (channelId: string, page: HistoryPage) => void;
  onDeltaFailed?: (channelId: string, err: unknown) => void;
}): Promise<void> {
  const entries = Object.entries(timelines);
  if (firstChannelId !== undefined) {
    const first = entries.findIndex(([channelId]) => channelId === firstChannelId);
    if (first > 0) entries.unshift(...entries.splice(first, 1));
  }
  for (const [channelId, timeline] of entries) {
    if (isDisposed?.()) return;
    const cachedLastEventId = cachedTimelineLastEventId(timeline);
    let hydratedHasMore = timeline.hasMore;
    if (!cachedTimelineNeedsCursorRepair(timeline, syncCursor) && !cachedTimelineNeedsStructuralRepair(timeline)) {
      dispatch({
        type: 'history-loaded',
        channelId,
        events: timeline.events,
        hasMore: timeline.hasMore,
      });
    } else {
      try {
        const latest = await fetchLatest(channelId);
        if (isDisposed?.()) return;
        dispatch({
          type: 'history-reset',
          channelId,
          events: latest.events,
          hasMore: latest.hasMore,
          readCursor: latest.readCursor,
        });
        hydratedHasMore = latest.hasMore;
        onRepaired?.(channelId, latest);
      } catch (err) {
        if (isDisposed?.()) return;
        // The refetch failed — a cold or briefly-slow server, a network blip. Do
        // NOT leave the channel with no history at all: this branch used to
        // dispatch nothing and never retry, so a failed repair rendered a blank
        // channel (and a deep-linked thread whose root was never found) until the
        // user reloaded again. That is strictly worse than the stale cache we
        // already hold, and it failed silently.
        //
        // Fall back to the cached events. They are stale or structurally imperfect
        // — that is why repair was attempted — but they are the same events the
        // no-repair-needed path above dispatches, and the live WS/sync stream
        // reconciles from here. Degraded beats blank.
        dispatch({
          type: 'history-loaded',
          channelId,
          events: timeline.events,
          hasMore: timeline.hasMore,
        });
        onRepairFailed?.(channelId, err);
      }
    }

    try {
      const delta = await fetchDelta(channelId, cachedLastEventId);
      if (isDisposed?.()) return;
      // An empty delta must be a true timeline no-op. A server cursor still
      // travels through the composite action and advances in place.
      if (delta.events.length === 0 && delta.readCursor === undefined) continue;
      dispatch({
        type: 'history-loaded',
        channelId,
        events: delta.events,
        // after_id's hasMore describes the forward delta, not older history.
        hasMore: hydratedHasMore,
        ...(delta.nextCursor !== undefined ? { nextCursor: delta.nextCursor } : {}),
        catchupCursor: cachedLastEventId,
        origin: 'channel-delta',
        readCursor: delta.readCursor,
      });
      onDeltaLoaded?.(channelId, delta);
    } catch (err) {
      if (isDisposed?.()) return;
      // Cached history is already visible. The initial workspace sync and live
      // WebSocket can still reconcile this channel after a transient failure.
      onDeltaFailed?.(channelId, err);
    }
  }
}
