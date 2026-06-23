import type { AppAction, CachedTimeline, WireEvent } from '@atrium/surface-client';

interface LatestPage {
  events: WireEvent[];
  hasMore: boolean;
}

export function cachedTimelineLastEventId(timeline: CachedTimeline): number {
  return timeline.events.reduce((max, event) => Math.max(max, event.id), 0);
}

export function cachedTimelineNeedsCursorRepair(
  timeline: CachedTimeline,
  syncCursor: number,
): boolean {
  return syncCursor > 0 && cachedTimelineLastEventId(timeline) < syncCursor;
}

function targetEventId(event: WireEvent): number | null {
  const value = event.payload?.target_event_id;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function isRowEvent(type: string): boolean {
  return (
    type === 'message.posted' ||
    type === 'session.spawned' ||
    type === 'session.question_requested' ||
    type === 'session.question_answered' ||
    type === 'session.question_resolved'
  );
}

export function cachedTimelineNeedsStructuralRepair(timeline: CachedTimeline): boolean {
  const rowIds = new Set(
    timeline.events
      .filter((event) => event.threadRootEventId == null && isRowEvent(event.type))
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
    if (
      !cachedTimelineNeedsCursorRepair(timeline, syncCursor) &&
      !cachedTimelineNeedsStructuralRepair(timeline)
    ) {
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
      onRepairFailed?.(channelId, err);
    }
  }
}
