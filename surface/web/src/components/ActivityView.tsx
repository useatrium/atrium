import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  activityKindMarker,
  formatExactTimestamp,
  formatRelativeTimestamp,
  isActivityUnread,
  matchesActivityFilter,
  type ActivityCounts,
  type ActivityFeedFilter,
  type ActivityItem,
  type WireEvent,
} from '@atrium/surface-client';
import { api } from '../api';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './a11y';
import { CompactMarkdownText } from './MessageText';

const FILTERS: Array<{ id: ActivityFeedFilter; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'unread', label: 'Unread' },
  { id: 'all', label: 'All' },
];

const PEOPLE_ACTIVITY_KINDS = new Set<ActivityItem['kind']>([
  'mention',
  'dm',
  'thread_reply',
  'reaction',
  'channel_invite',
  'missed_call',
  'call_declined',
]);

export function isPeopleActivity(item: ActivityItem): boolean {
  return PEOPLE_ACTIVITY_KINDS.has(item.kind);
}

function titleFor(item: ActivityItem): string {
  if (item.kind === 'mention') return `${item.actorName ?? 'Someone'} mentioned you`;
  if (item.kind === 'dm') {
    // DM channel names are internal keys; the gdm: prefix is the only group signal.
    return item.channelName.startsWith('gdm:')
      ? `${item.actorName ?? 'Someone'} messaged the group`
      : `${item.actorName ?? 'Someone'} sent a DM`;
  }
  if (item.kind === 'thread_reply') return `${item.actorName ?? 'Someone'} replied in a thread`;
  if (item.kind === 'agent_question') {
    return item.sessionTitle ? `${item.sessionTitle} · needs your answer` : 'Agent needs your input';
  }
  if (item.kind === 'session_completed') {
    return item.sessionTitle ? `${item.sessionTitle} · completed` : 'Agent completed';
  }
  if (item.kind === 'session_failed') return `${item.sessionTitle ?? 'Agent'} failed`;
  if (item.kind === 'agent_auth') return `${item.sessionTitle ?? 'Agent'} is blocked — reconnect provider`;
  if (item.kind === 'reaction') return `${item.actorName ?? 'Someone'} reacted to your message`;
  if (item.kind === 'channel_invite') return `${item.actorName ?? 'Someone'} added you`;
  if (item.kind === 'seat_request')
    return `${item.actorName ?? 'Someone'} wants to drive · ${item.sessionTitle ?? 'a session'}`;
  if (item.kind === 'missed_call') return `${item.actorName ?? 'Someone'} called you`;
  if (item.kind === 'call_declined') return `${item.actorName ?? 'Someone'} called · you declined`;
  return 'Activity';
}

// DM channel names are internal keys (dm:/gdm:), and calls only happen in
// DMs/GDMs — the row title already names the other person in all these kinds.
function hideChannelLabel(item: ActivityItem): boolean {
  return item.kind === 'dm' || item.kind === 'missed_call' || item.kind === 'call_declined';
}

function activityAriaLabel(item: ActivityItem, exactTimestamp: string, unread: boolean): string {
  return [
    unread ? 'Unread' : null,
    titleFor(item),
    exactTimestamp ? `created ${exactTimestamp}` : null,
    item.snippet,
    hideChannelLabel(item) ? null : `channel ${item.channelName}`,
  ]
    .filter(Boolean)
    .join(', ');
}

function parseEventId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function ActivityRow({
  item,
  unread,
  onActivate,
  onMarkRead,
  onMarkUnread,
}: {
  item: ActivityItem;
  unread: boolean;
  onActivate: (item: ActivityItem) => void;
  onMarkRead: (item: ActivityItem) => void;
  onMarkUnread: (item: ActivityItem) => void;
}) {
  const relativeTimestamp = formatRelativeTimestamp(item.createdAt);
  const exactTimestamp = formatExactTimestamp(item.createdAt);

  return (
    <li>
      <div className="group flex w-full items-start gap-2 px-4 py-3 hover:bg-surface-overlay/70">
        <button
          type="button"
          onClick={() => onActivate(item)}
          aria-label={activityAriaLabel(item, exactTimestamp, unread)}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <span className="mt-0.5 grid h-6 min-w-8 place-items-center rounded bg-surface-raised text-2xs font-bold text-fg-muted">
            {activityKindMarker(item.kind)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              {unread && (
                <span role="img" aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-accent-text" />
              )}
              <span className="truncate text-sm font-semibold text-fg">{titleFor(item)}</span>
              {relativeTimestamp && (
                <span className="shrink-0 text-2xs text-fg-faint" title={exactTimestamp || undefined}>
                  {relativeTimestamp}
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-sm text-fg-secondary">
              <CompactMarkdownText text={item.snippet} />
            </span>
            {!hideChannelLabel(item) && (
              <span className="mt-1 block truncate text-xs text-fg-muted">#{item.channelName}</span>
            )}
          </span>
        </button>
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for ${titleFor(item)}`}
              className="mt-0.5 shrink-0 rounded-md px-1.5 py-1 text-xs font-semibold text-fg-muted opacity-0 hover:bg-surface-raised hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              onClick={(event) => event.stopPropagation()}
            >
              ⋯
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            {unread ? (
              <MenuItem onSelect={() => onMarkRead(item)}>Mark read</MenuItem>
            ) : (
              <MenuItem onSelect={() => onMarkUnread(item)}>Mark unread</MenuItem>
            )}
          </MenuContent>
        </Menu>
      </div>
    </li>
  );
}

export function ActivityView({
  onSelectChannel,
  liveEvent = null,
  refreshKey = 0,
  onCountsChange,
}: {
  onSelectChannel: (channelId: string) => void;
  /** Delivered by Chat's existing WebSocket hub; this component opens no socket. */
  liveEvent?: WireEvent | null;
  /** Increments after a WebSocket reconnect to heal any gap in the feed. */
  refreshKey?: number;
  onCountsChange?: (counts: ActivityCounts) => void;
}) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [lastReadEventId, setLastReadEventId] = useState('0');
  const [unreadExceptionIds, setUnreadExceptionIds] = useState<string[]>([]);
  const [counts, setCounts] = useState<ActivityCounts>({ attention: 0, unread: 0 });
  const [filter, setFilter] = useState<ActivityFeedFilter>('inbox');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const lastRefreshKeyRef = useRef(refreshKey);
  const exceptionSet = useMemo(() => new Set(unreadExceptionIds), [unreadExceptionIds]);

  const applyReadState = useCallback(
    (state: { lastReadEventId: string; unreadExceptionIds?: string[] }, nextCounts?: ActivityCounts) => {
      setLastReadEventId(state.lastReadEventId);
      if (Array.isArray(state.unreadExceptionIds)) {
        setUnreadExceptionIds(state.unreadExceptionIds.map(String));
      }
      if (nextCounts) {
        setCounts(nextCounts);
        onCountsChange?.(nextCounts);
      }
    },
    [onCountsChange],
  );

  const load = useCallback(
    async (cursor?: string, background = false) => {
      const requestId = ++loadRequestRef.current;
      if (cursor) setLoadingMore(true);
      else if (!background) setLoading(true);
      if (!background) setError(null);
      try {
        const res = await api.getActivity(cursor);
        if (requestId !== loadRequestRef.current) return;
        const peopleItems = res.items.filter(isPeopleActivity);
        setItems((previous) => (cursor ? [...previous, ...peopleItems] : peopleItems));
        setNextCursor(res.nextCursor);
        // Decode-with-default: a deploy-skewed server may predate read-state.
        setLastReadEventId(typeof res.lastReadEventId === 'string' ? res.lastReadEventId : '0');
        setUnreadExceptionIds(Array.isArray(res.unreadExceptionIds) ? res.unreadExceptionIds.map(String) : []);
        const nextCounts: ActivityCounts = {
          attention: 0,
          unread: peopleItems.filter((item) => isActivityUnread(item, '0')).length,
          needsYou: 0,
          running: 0,
          toReview: 0,
        };
        setCounts(nextCounts);
        onCountsChange?.(nextCounts);
      } catch (err) {
        if (requestId === loadRequestRef.current) {
          setError(err instanceof Error ? err.message : 'Unable to load activity');
        }
      } finally {
        if (cursor) setLoadingMore(false);
        else if (!background) setLoading(false);
      }
    },
    [onCountsChange],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const reconnected = refreshKey !== lastRefreshKeyRef.current;
    lastRefreshKeyRef.current = refreshKey;
    if (!liveEvent && !reconnected) return;
    const timer = window.setTimeout(() => void load(undefined, true), 150);
    return () => window.clearTimeout(timer);
  }, [liveEvent, load, refreshKey]);

  const markItemRead = useCallback(
    async (item: ActivityItem) => {
      const eventId = parseEventId(item.eventId);
      if (eventId == null) return;
      const previous = { lastReadEventId, unreadExceptionIds, counts, items };
      // Optimistic: strip this exception and bump watermark through this id.
      const nextExceptions = unreadExceptionIds.filter((id) => id !== item.eventId);
      const nextWatermark = Number(lastReadEventId) < eventId ? String(eventId) : lastReadEventId;
      setLastReadEventId(nextWatermark);
      setUnreadExceptionIds(nextExceptions);
      setCounts((c) => {
        const next = { ...c, unread: Math.max(0, c.unread - 1) };
        onCountsChange?.(next);
        return next;
      });
      setItems((rows) => rows.map((row) => (row.eventId === item.eventId ? { ...row, unread: false } : row)));
      try {
        const response = await api.markActivityItemRead(eventId);
        applyReadState(response);
        void load(undefined, true);
      } catch (err) {
        setLastReadEventId(previous.lastReadEventId);
        setUnreadExceptionIds(previous.unreadExceptionIds);
        setCounts(previous.counts);
        setItems(previous.items);
        onCountsChange?.(previous.counts);
        setError(err instanceof Error ? err.message : 'Unable to mark activity read');
        void load(undefined, true);
      }
    },
    [applyReadState, counts, items, lastReadEventId, load, onCountsChange, unreadExceptionIds],
  );

  const markItemUnread = useCallback(
    async (item: ActivityItem) => {
      const eventId = parseEventId(item.eventId);
      if (eventId == null) return;
      const previous = { lastReadEventId, unreadExceptionIds, counts, items };
      if (!unreadExceptionIds.includes(item.eventId) && Number(item.eventId) <= Number(lastReadEventId)) {
        setUnreadExceptionIds((ids) => [...ids, item.eventId]);
      }
      setCounts((c) => {
        const next = { ...c, unread: Math.min(99, c.unread + 1) };
        onCountsChange?.(next);
        return next;
      });
      setItems((rows) => rows.map((row) => (row.eventId === item.eventId ? { ...row, unread: true } : row)));
      try {
        const response = await api.markActivityItemUnread(eventId);
        applyReadState(response);
        void load(undefined, true);
      } catch (err) {
        setLastReadEventId(previous.lastReadEventId);
        setUnreadExceptionIds(previous.unreadExceptionIds);
        setCounts(previous.counts);
        setItems(previous.items);
        onCountsChange?.(previous.counts);
        setError(err instanceof Error ? err.message : 'Unable to mark activity unread');
        void load(undefined, true);
      }
    },
    [applyReadState, counts, items, lastReadEventId, load, onCountsChange, unreadExceptionIds],
  );

  const activate = (item: ActivityItem) => {
    const unread = isActivityUnread(item, lastReadEventId, exceptionSet);
    if (unread) void markItemRead(item);
    onSelectChannel(item.channelId);
  };

  const markAllRead = async () => {
    const newestEventId = Math.max(
      0,
      ...items.map((item) => {
        const id = Number(item.eventId);
        return Number.isSafeInteger(id) ? id : 0;
      }),
    );
    if (newestEventId <= 0 || markingRead) return;

    const previous = {
      cursor: lastReadEventId,
      exceptions: unreadExceptionIds,
      counts,
      items,
    };
    const optimisticCounts = { ...counts, unread: 0 };
    setMarkingRead(true);
    setLastReadEventId(String(newestEventId));
    setUnreadExceptionIds([]);
    setCounts(optimisticCounts);
    onCountsChange?.(optimisticCounts);
    setItems((rows) => rows.map((row) => ({ ...row, unread: false })));
    try {
      const response = await api.markActivityRead(newestEventId);
      applyReadState(response);
      // Refetch without blanking the list so state-cleared attention rows and
      // sidebar totals settle from the server's canonical snapshot.
      void load(undefined, true);
    } catch (err) {
      setLastReadEventId(previous.cursor);
      setUnreadExceptionIds(previous.exceptions);
      setCounts(previous.counts);
      setItems(previous.items);
      onCountsChange?.(previous.counts);
      setError(err instanceof Error ? err.message : 'Unable to mark activity read');
      void load(undefined, true);
    } finally {
      setMarkingRead(false);
    }
  };

  const filteredItems = useMemo(
    () =>
      items.filter((item) =>
        matchesActivityFilter(item, filter, isActivityUnread(item, lastReadEventId, exceptionSet)),
      ),
    [exceptionSet, filter, items, lastReadEventId],
  );
  const tabCount = useCallback(
    (tab: ActivityFeedFilter) =>
      items.filter((item) => {
        const unread = isActivityUnread(item, lastReadEventId, exceptionSet);
        return matchesActivityFilter(item, tab, unread);
      }).length,
    [exceptionSet, items, lastReadEventId],
  );

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Loading Inbox...</div>;
  }

  const empty = filteredItems.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
        <h1 className="text-sm font-bold text-fg">Inbox</h1>
        <div
          role="tablist"
          aria-label="Activity filters"
          className="flex flex-wrap items-center gap-1 rounded-md border border-edge bg-surface-raised/30 p-0.5"
        >
          {FILTERS.map((entry) => {
            const selected = filter === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setFilter(entry.id)}
                className={`rounded px-2 py-0.5 text-2xs font-semibold ${
                  selected ? 'bg-surface-overlay text-fg shadow-sm' : 'text-fg-muted hover:text-fg-body'
                }`}
              >
                {entry.id === 'all' ? entry.label : `${entry.label} · ${tabCount(entry.id)}`}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={markingRead || counts.unread === 0 || items.length === 0}
          className="ml-auto rounded-md border border-edge bg-surface-raised/40 px-2.5 py-1 text-xs font-semibold text-fg-muted hover:bg-surface-overlay hover:text-fg-body disabled:cursor-default disabled:opacity-60"
        >
          {markingRead ? 'Marking read...' : 'Mark all read'}
        </button>
      </div>
      {error && (
        <button
          type="button"
          onClick={() => void load()}
          className="mx-4 mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-left text-sm text-danger hover:bg-danger/15"
        >
          Inbox couldn&apos;t load. Click to retry.
        </button>
      )}
      {items.length === 0 && !error && filter === 'inbox' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-sm font-semibold text-fg">You&apos;re all caught up</p>
          <p className="max-w-md text-sm text-fg-muted">
            Mentions, DMs, reactions, thread replies, and calls will land here.
          </p>
        </div>
      ) : empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-sm font-semibold text-fg">
            {filter === 'unread' ? 'No unread activity' : 'Nothing in this view'}
          </p>
          <p className="max-w-md text-sm text-fg-muted">Try another filter, or mark items unread to keep them here.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filteredItems.length > 0 && (
            <section aria-labelledby="activity-history">
              <h2
                id="activity-history"
                className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-fg-muted"
              >
                Activity
              </h2>
              <ul className="divide-y divide-edge">
                {filteredItems.map((item) => (
                  <ActivityRow
                    key={`${item.kind}:${item.eventId}`}
                    item={item}
                    unread={isActivityUnread(item, lastReadEventId, exceptionSet)}
                    onActivate={(target) => void activate(target)}
                    onMarkRead={(target) => void markItemRead(target)}
                    onMarkUnread={(target) => void markItemUnread(target)}
                  />
                ))}
              </ul>
            </section>
          )}
          {nextCursor && (
            <div className="border-t border-edge p-3">
              <button
                type="button"
                onClick={() => void load(nextCursor)}
                disabled={loadingMore}
                className="rounded-md border border-edge bg-surface-raised/40 px-3 py-1.5 text-xs font-semibold text-fg-muted hover:bg-surface-overlay hover:text-fg-body disabled:cursor-default disabled:opacity-60"
              >
                {loadingMore ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
