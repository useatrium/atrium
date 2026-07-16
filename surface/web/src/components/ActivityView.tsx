import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  activityKindMarker,
  formatExactTimestamp,
  formatOutcome,
  formatRelativeTimestamp,
  formatWaiting,
  isActivityUnread,
  matchesActivityFilter,
  matchesActivitySource,
  type ActivityChannelCounts,
  type ActivityCounts,
  type ActivityFeedFilter,
  type ActivityItem,
  type ActivitySourceFilter,
  type WireEvent,
} from '@atrium/surface-client';
import { api } from '../api';
import { isTerminalSessionStatus, type Session } from '../sessions/types';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './a11y';
import { CompactMarkdownText } from './MessageText';

const ATTENTION_KINDS = new Set<ActivityItem['kind']>(['agent_question', 'agent_auth', 'session_failed']);

const FILTERS: Array<{ id: ActivityFeedFilter; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'unread', label: 'Unread' },
  { id: 'done', label: 'Reviewed' },
  { id: 'all', label: 'All' },
];

const SOURCE_FILTERS: Array<{ id: ActivitySourceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'agents', label: 'Agents' },
  { id: 'people', label: 'People' },
];

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

/** Pinned Needs attention kinds that stay until session state clears (except failures). */
function isHistoryKind(kind: ActivityItem['kind']): boolean {
  return !ATTENTION_KINDS.has(kind) || kind === 'session_failed';
}

export function partitionActivity(items: readonly ActivityItem[]): {
  attention: ActivityItem[];
  history: ActivityItem[];
} {
  const sessionIdsInAttention = new Set<string>();
  const attention: ActivityItem[] = [];
  const history: ActivityItem[] = [];

  for (const item of items) {
    const canPin = (ATTENTION_KINDS.has(item.kind) || isSyntheticRow(item)) && item.attention;
    if (!canPin) {
      history.push(item);
      continue;
    }

    // The feed is newest-first. Retain the first current state for a session
    // in the pinned tier and let any older sibling events remain in history.
    if (item.sessionId) {
      if (sessionIdsInAttention.has(item.sessionId)) {
        history.push(item);
        continue;
      }
      sessionIdsInAttention.add(item.sessionId);
    }
    attention.push(item);
  }

  return { attention, history };
}

function kindChipClass(item: ActivityItem, attention: boolean): string {
  if (!attention) return 'bg-surface-raised text-fg-muted';
  if (item.kind === 'session_failed') return 'bg-danger-tint text-danger-text-strong';
  return 'bg-warning-tint text-warning-text-strong';
}

function attentionEdgeClass(item: ActivityItem, attention: boolean): string {
  if (!attention) return '';
  return item.kind === 'session_failed' ? 'border-l-2 border-l-danger' : 'border-l-2 border-l-warning';
}

function parseEventId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Synthetic live-attention rows (`live:<sessionId>`) have no feed event behind
 * them, so every read-state op no-ops on them (see `markItemRead`). Offering
 * "Mark read" there is a button that lies — the row only leaves when the
 * session stops blocking on a person.
 */
function isSyntheticRow(item: ActivityItem): boolean {
  return parseEventId(item.eventId) == null;
}

function isTerminalActivity(item: ActivityItem): boolean {
  return item.kind === 'session_completed' || item.kind === 'session_failed';
}

function outcomeFor(item: ActivityItem, session?: Session): string | null {
  if (!isTerminalActivity(item)) return null;
  const status = item.kind === 'session_completed' ? 'completed' : 'failed';
  if (!session?.completedAt) return null;
  return formatOutcome(status, new Date(session.completedAt).getTime() - new Date(session.createdAt).getTime());
}

/** What actually makes a synthetic row go away — shown where its ⋯ menu would be. */
function clearsWhenLabel(item: ActivityItem): string {
  return item.kind === 'agent_auth' ? 'Clears when reconnected' : 'Clears when answered';
}

function ActivityRow({
  item,
  attention,
  unread,
  answerSession,
  onActivate,
  onMarkRead,
  onMarkUnread,
  session,
  onArchiveSession,
}: {
  item: ActivityItem;
  attention: boolean;
  unread: boolean;
  /** Live session whose pending question this row points at ("Answer →" opens it). */
  answerSession?: Session;
  onActivate: (item: ActivityItem) => void;
  onMarkRead: (item: ActivityItem) => void;
  onMarkUnread: (item: ActivityItem) => void;
  session?: Session;
  onArchiveSession?: (session: Session) => void;
}) {
  const relativeTimestamp = formatRelativeTimestamp(item.createdAt);
  const exactTimestamp = formatExactTimestamp(item.createdAt);

  return (
    <li>
      <div
        className={`group flex w-full items-start gap-2 px-4 py-3 hover:bg-surface-overlay/70 ${attentionEdgeClass(item, attention)}`}
      >
        <button
          type="button"
          onClick={() => onActivate(item)}
          aria-label={activityAriaLabel(item, exactTimestamp, unread)}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <span
            className={`mt-0.5 grid h-6 min-w-8 place-items-center rounded text-2xs font-bold ${kindChipClass(item, attention)}`}
          >
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
            {outcomeFor(item, session) && (
              <span className="mt-0.5 block truncate text-xs font-semibold text-fg-secondary">
                {outcomeFor(item, session)}
              </span>
            )}
            <span className="mt-0.5 block truncate text-sm text-fg-secondary">
              <CompactMarkdownText text={item.snippet} />
            </span>
            {!hideChannelLabel(item) && (
              <span className="mt-1 block truncate text-xs text-fg-muted">#{item.channelName}</span>
            )}
          </span>
        </button>
        {isSyntheticRow(item) ? (
          <span
            data-testid="activity-clears-when"
            className="mt-0.5 shrink-0 whitespace-nowrap px-1.5 py-1 text-2xs text-fg-faint"
          >
            {clearsWhenLabel(item)}
          </span>
        ) : (
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
                <MenuItem
                  onSelect={() => {
                    onMarkRead(item);
                  }}
                >
                  Mark read
                </MenuItem>
              ) : (
                <MenuItem
                  onSelect={() => {
                    onMarkUnread(item);
                  }}
                >
                  Mark unread
                </MenuItem>
              )}
              {session && isTerminalSessionStatus(session.status) && session.archivedAt == null && onArchiveSession && (
                <MenuItem onSelect={() => onArchiveSession(session)}>Archive session</MenuItem>
              )}
            </MenuContent>
          </Menu>
        )}
      </div>
      {answerSession?.pendingQuestion && (
        <div className="px-4 pb-3 pl-14">
          <button
            type="button"
            data-testid="question-pointer"
            onClick={() => onActivate(item)}
            className="flex w-full items-center gap-1.5 rounded-md border border-warning-border/40 bg-warning-tint/10 px-2 py-1.5 text-left text-xs text-warning-text-strong hover:bg-warning-tint/25"
          >
            <span className="min-w-0 flex-1 truncate">
              {answerSession.pendingQuestion.questions[0]?.question ?? 'The agent asked a question'}
            </span>
            <span className="shrink-0 font-semibold">Answer →</span>
          </button>
        </div>
      )}
    </li>
  );
}

function RunningSessionRow({
  session,
  channelName,
  now,
  onOpenSession,
}: {
  session: Session;
  channelName: string;
  now: number;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenSession(session.id)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-overlay/70"
      >
        <span className="mt-0.5 text-xs text-success-text" aria-hidden="true">
          ●
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{session.title}</span>
            <span className="shrink-0 text-2xs tabular-nums text-fg-faint">
              {formatWaiting(now - new Date(session.createdAt).getTime())}
            </span>
          </span>
          {session.latestActivity?.summary && (
            <span className="mt-0.5 block truncate text-sm text-fg-secondary">{session.latestActivity.summary}</span>
          )}
          <span className="mt-1 block truncate text-xs text-fg-muted">#{channelName}</span>
        </span>
      </button>
    </li>
  );
}

export function ActivityView({
  onSelectChannel,
  onOpenSession,
  liveEvent = null,
  refreshKey = 0,
  liveAttention = [],
  sessions = {},
  channelNames = {},
  onOpenAgents,
  onArchiveSession,
  onCountsChange,
}: {
  onSelectChannel: (channelId: string) => void;
  onOpenSession: (sessionId: string) => void;
  /** Delivered by Chat's existing WebSocket hub; this component opens no socket. */
  liveEvent?: WireEvent | null;
  /** Increments after a WebSocket reconnect to heal any gap in the feed. */
  refreshKey?: number;
  /**
   * Synthetic pinned rows for LIVE sessions blocked on a person (question /
   * auth / seat), so the Needs-attention tier reacts the instant a session
   * blocks instead of waiting for the feed item — parity with the mobile tab.
   * Synthetic eventIds ("live:…") don't parse, so read-state ops no-op.
   */
  liveAttention?: ActivityItem[];
  /** Live session entities — needs-attention question rows point at them ("Answer →"). */
  sessions?: Record<string, Session>;
  /** Channel labels for live session mirrors, supplied by Chat's channel state. */
  channelNames?: Record<string, string>;
  onOpenAgents?: () => void;
  onArchiveSession?: (sessionId: string, previousArchivedAt: string | null) => void;
  onCountsChange?: (counts: ActivityCounts, channelCounts?: Record<string, ActivityChannelCounts>) => void;
}) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [lastReadEventId, setLastReadEventId] = useState('0');
  const [unreadExceptionIds, setUnreadExceptionIds] = useState<string[]>([]);
  const [counts, setCounts] = useState<ActivityCounts>({ attention: 0, unread: 0 });
  const [filter, setFilter] = useState<ActivityFeedFilter>('inbox');
  const [source, setSource] = useState<ActivitySourceFilter>('all');
  const [now, setNow] = useState(() => Date.now());
  const [archivedSessionIds, setArchivedSessionIds] = useState<Set<string>>(() => new Set());
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
        setItems((previous) => (cursor ? [...previous, ...res.items] : res.items));
        setNextCursor(res.nextCursor);
        // Decode-with-default: a deploy-skewed server may predate read-state.
        setLastReadEventId(typeof res.lastReadEventId === 'string' ? res.lastReadEventId : '0');
        setUnreadExceptionIds(Array.isArray(res.unreadExceptionIds) ? res.unreadExceptionIds.map(String) : []);
        const nextCounts = {
          attention: Number(res.counts?.attention) || 0,
          unread: Number(res.counts?.unread) || 0,
          needsYou: Number(res.counts?.needsYou) || 0,
          running: Number(res.counts?.running) || 0,
          toReview: Number(res.counts?.toReview) || 0,
        };
        setCounts(nextCounts);
        onCountsChange?.(nextCounts, res.channelCounts);
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
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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

  const activate = async (item: ActivityItem) => {
    // History rows (including failures in history) auto-mark read on open.
    // Live question/auth pins stay until the session state clears.
    const unread = isActivityUnread(item, lastReadEventId, exceptionSet);
    if (unread && isHistoryKind(item.kind) && !item.attention) {
      void markItemRead(item);
    }

    onSelectChannel(item.channelId);
    if (
      item.kind !== 'agent_question' &&
      item.kind !== 'session_completed' &&
      item.kind !== 'session_failed' &&
      item.kind !== 'agent_auth'
    ) {
      return;
    }
    // A synthetic row already names its session — there is no feed event to
    // resolve it from. The eventId guard below exists for that lookup, but it
    // was also stranding this click in the channel with nothing opened: the one
    // row in the app that says someone is waiting on you was a dead end.
    if (isSyntheticRow(item)) {
      if (item.sessionId) onOpenSession(item.sessionId);
      return;
    }
    const eventId = parseEventId(item.eventId);
    if (eventId == null) return;
    try {
      const { events } = await api.messages(item.channelId, {
        afterId: eventId - 1,
        limit: 1,
      });
      const event = events.find((candidate) => candidate.id === eventId);
      const sessionId = event && typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : null;
      if (sessionId) onOpenSession(sessionId);
    } catch (err) {
      console.warn('failed to resolve activity session', err);
    }
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

  // A live blocked session pins immediately; once the server's feed item for
  // the same session arrives, the real (mark-readable) row takes over.
  const merged = useMemo(() => {
    if (liveAttention.length === 0) return items;
    const covered = new Set(
      items
        .filter((item) => ATTENTION_KINDS.has(item.kind) && item.attention && item.sessionId)
        .map((item) => item.sessionId),
    );
    const extra = liveAttention.filter((item) => item.sessionId && !covered.has(item.sessionId));
    return extra.length > 0 ? [...extra, ...items] : items;
  }, [items, liveAttention]);

  const visibleItems = useMemo(
    () =>
      merged.filter((item) => {
        if (!item.sessionId) return true;
        if (archivedSessionIds.has(item.sessionId)) return false;
        return sessions[item.sessionId]?.archivedAt == null;
      }),
    [archivedSessionIds, merged, sessions],
  );
  const { attention, history } = useMemo(() => partitionActivity(visibleItems), [visibleItems]);

  const filteredAttention = useMemo(
    () =>
      attention.filter(
        (item) =>
          matchesActivityFilter(item, filter, isActivityUnread(item, lastReadEventId, exceptionSet)) &&
          matchesActivitySource(item, source),
      ),
    [attention, exceptionSet, filter, lastReadEventId, source],
  );
  const filteredHistory = useMemo(
    () =>
      history.filter(
        (item) =>
          matchesActivityFilter(item, filter, isActivityUnread(item, lastReadEventId, exceptionSet)) &&
          matchesActivitySource(item, source),
      ),
    [exceptionSet, filter, history, lastReadEventId, source],
  );
  const needsYou = useMemo(
    () => [...filteredAttention].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [filteredAttention],
  );
  const runningSessions = useMemo(
    () =>
      source === 'people'
        ? []
        : Object.values(sessions).filter(
            (session) => !isTerminalSessionStatus(session.status) && session.archivedAt == null,
          ),
    [sessions, source],
  );
  // A failed run that is pinned in Needs you must not ALSO shelve under To
  // review — one session, one shelf. Partition already routed pinned items
  // into `attention`, so derive To review from `history` and drop any item
  // whose session currently holds a Needs-you pin.
  const pinnedSessionIds = useMemo(
    () => new Set(attention.map((item) => item.sessionId).filter((id): id is string => id != null)),
    [attention],
  );
  const toReview = useMemo(
    () =>
      history.filter(
        (item) =>
          isTerminalActivity(item) &&
          !(item.sessionId != null && pinnedSessionIds.has(item.sessionId)) &&
          isActivityUnread(item, lastReadEventId, exceptionSet) &&
          matchesActivitySource(item, source),
      ),
    [exceptionSet, history, lastReadEventId, pinnedSessionIds, source],
  );
  const historyWithoutReview = useMemo(
    () =>
      filter === 'inbox'
        ? filteredHistory.filter(
            (item) => !(isTerminalActivity(item) && isActivityUnread(item, lastReadEventId, exceptionSet)),
          )
        : filteredHistory,
    [exceptionSet, filter, filteredHistory, lastReadEventId],
  );
  const tabCount = useCallback(
    (tab: ActivityFeedFilter) =>
      visibleItems.filter((item) => {
        const unread = isActivityUnread(item, lastReadEventId, exceptionSet);
        return matchesActivityFilter(item, tab, unread) && matchesActivitySource(item, source);
      }).length,
    [exceptionSet, lastReadEventId, source, visibleItems],
  );

  const archiveSession = useCallback(
    (session: Session) => {
      setArchivedSessionIds((ids) => new Set(ids).add(session.id));
      onArchiveSession?.(session.id, session.archivedAt);
    },
    [onArchiveSession],
  );

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Loading attention...</div>;
  }

  const showShelves = filter === 'inbox';
  const empty =
    (showShelves ? needsYou.length === 0 && runningSessions.length === 0 && toReview.length === 0 : true) &&
    historyWithoutReview.length === 0;
  const hasLiveContent = runningSessions.length > 0 || liveAttention.length > 0;

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
        <fieldset className="flex items-center gap-1 rounded-md border border-edge bg-surface-raised/30 p-0.5">
          <legend className="sr-only">Activity source</legend>
          {SOURCE_FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={source === entry.id}
              onClick={() => setSource(entry.id)}
              className={`rounded px-2 py-0.5 text-2xs font-semibold ${
                source === entry.id ? 'bg-surface-overlay text-fg shadow-sm' : 'text-fg-muted hover:text-fg-body'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </fieldset>
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
      {items.length === 0 && !hasLiveContent && !error && filter === 'inbox' && source === 'all' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-sm font-semibold text-fg">You&apos;re all caught up</p>
          <p className="max-w-md text-sm text-fg-muted">
            Mentions, DMs, agent questions, and agent results will land here when they need you.
          </p>
        </div>
      ) : empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-sm font-semibold text-fg">
            {filter === 'done'
              ? 'No reviewed sessions'
              : filter === 'unread'
                ? 'No unread activity'
                : 'Nothing in this view'}
          </p>
          <p className="max-w-md text-sm text-fg-muted">
            {filter === 'done'
              ? 'Completed and failed sessions appear here after you review them.'
              : 'Try another filter, or mark items unread to keep them here.'}
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {showShelves && needsYou.length > 0 && (
            <section aria-labelledby="inbox-needs-you">
              <h2
                id="inbox-needs-you"
                className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-warning-text"
              >
                Needs you · {needsYou.length}
              </h2>
              <ul className="divide-y divide-edge border-b border-edge">
                {needsYou.map((item) => (
                  <ActivityRow
                    key={`${item.kind}:${item.eventId}`}
                    item={item}
                    attention
                    unread={isActivityUnread(item, lastReadEventId, exceptionSet)}
                    answerSession={
                      item.kind === 'agent_question' && item.sessionId ? sessions[item.sessionId] : undefined
                    }
                    onActivate={(target) => void activate(target)}
                    onMarkRead={(target) => void markItemRead(target)}
                    onMarkUnread={(target) => void markItemUnread(target)}
                    session={item.sessionId ? sessions[item.sessionId] : undefined}
                    onArchiveSession={archiveSession}
                  />
                ))}
              </ul>
            </section>
          )}
          {showShelves && runningSessions.length > 0 && (
            <section aria-labelledby="inbox-running">
              <h2
                id="inbox-running"
                className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-fg-muted"
              >
                Running · {runningSessions.length}
              </h2>
              <ul className="divide-y divide-edge border-b border-edge">
                {runningSessions.map((session) => (
                  <RunningSessionRow
                    key={session.id}
                    session={session}
                    channelName={channelNames[session.channelId] ?? session.channelId}
                    now={now}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </ul>
            </section>
          )}
          {showShelves && toReview.length > 0 && (
            <section aria-labelledby="inbox-to-review">
              <h2
                id="inbox-to-review"
                className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-fg-muted"
              >
                To review · {toReview.length}
              </h2>
              <ul className="divide-y divide-edge border-b border-edge">
                {toReview.map((item) => (
                  <ActivityRow
                    key={`review:${item.kind}:${item.eventId}`}
                    item={item}
                    attention={false}
                    unread={isActivityUnread(item, lastReadEventId, exceptionSet)}
                    onActivate={(target) => void activate(target)}
                    onMarkRead={(target) => void markItemRead(target)}
                    onMarkUnread={(target) => void markItemUnread(target)}
                    session={item.sessionId ? sessions[item.sessionId] : undefined}
                    onArchiveSession={archiveSession}
                  />
                ))}
              </ul>
            </section>
          )}
          {showShelves && onOpenAgents && (
            <div className="border-b border-edge px-4 py-3">
              <button
                type="button"
                onClick={onOpenAgents}
                className="text-xs font-semibold text-accent-text hover:underline"
              >
                All sessions →
              </button>
            </div>
          )}
          {historyWithoutReview.length > 0 && (
            <section aria-labelledby="activity-history">
              <h2
                id="activity-history"
                className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-fg-muted"
              >
                {filter === 'done' ? 'Reviewed' : 'Activity'}
              </h2>
              <ul className="divide-y divide-edge">
                {historyWithoutReview.map((item) => (
                  <ActivityRow
                    key={`${item.kind}:${item.eventId}`}
                    item={item}
                    attention={false}
                    unread={isActivityUnread(item, lastReadEventId, exceptionSet)}
                    onActivate={(target) => void activate(target)}
                    onMarkRead={(target) => void markItemRead(target)}
                    onMarkUnread={(target) => void markItemUnread(target)}
                    session={item.sessionId ? sessions[item.sessionId] : undefined}
                    onArchiveSession={archiveSession}
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
