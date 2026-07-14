import type { AppAction, CachedTimeline, WireEvent } from '@atrium/surface-client';
import { eventIdFromTarget } from '@atrium/surface-client/handle';

interface LatestPage {
  events: WireEvent[];
  hasMore: boolean;
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
  fetchLatest,
  isDisposed,
  onRepaired,
  onRepairFailed,
}: {
  timelines: Record<string, CachedTimeline>;
  syncCursor: number;
  dispatch: (action: AppAction) => void;
  fetchLatest: (channelId: string) => Promise<LatestPage>;
  isDisposed?: () => boolean;
  onRepaired?: (channelId: string, page: LatestPage) => void;
  onRepairFailed?: (channelId: string, err: unknown) => void;
}): Promise<void> {
  for (const [channelId, timeline] of Object.entries(timelines)) {
    if (isDisposed?.()) return;
    if (!cachedTimelineNeedsCursorRepair(timeline, syncCursor) && !cachedTimelineNeedsStructuralRepair(timeline)) {
      dispatch({
        type: 'history-loaded',
        channelId,
        events: timeline.events,
        hasMore: timeline.hasMore,
      });
      continue;
    }

    try {
      const latest = await fetchLatest(channelId);
      if (isDisposed?.()) return;
      dispatch({
        type: 'history-reset',
        channelId,
        events: latest.events,
        hasMore: latest.hasMore,
      });
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
}
