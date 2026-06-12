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
    if (!cachedTimelineNeedsCursorRepair(timeline, syncCursor)) {
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
