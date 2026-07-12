import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatExactTimestamp,
  formatRelativeTimestamp,
  type ActivityCounts,
  type ActivityItem,
  type WireEvent,
} from '@atrium/surface-client';
import { api } from '../api';
import { CompactMarkdownText } from './MessageText';

const ATTENTION_KINDS = new Set<ActivityItem['kind']>(['agent_question', 'agent_auth', 'session_failed']);

const KIND_LABEL: Record<ActivityItem['kind'], string> = {
  mention: '@',
  dm: 'DM',
  thread_reply: '↩',
  agent_question: '?',
  session_completed: 'OK',
  session_failed: '!',
  agent_auth: '⚿',
};

function titleFor(item: ActivityItem): string {
  if (item.kind === 'mention') return `${item.actorName ?? 'Someone'} mentioned you`;
  if (item.kind === 'dm') return `${item.actorName ?? 'Someone'} sent a DM`;
  if (item.kind === 'thread_reply') return `${item.actorName ?? 'Someone'} replied in a thread`;
  if (item.kind === 'agent_question') {
    return item.sessionTitle ? `${item.sessionTitle} · needs your answer` : 'Agent needs your input';
  }
  if (item.kind === 'session_completed') {
    return item.sessionTitle ? `${item.sessionTitle} · completed` : 'Agent completed';
  }
  if (item.kind === 'session_failed') return `${item.sessionTitle ?? 'Agent'} failed`;
  if (item.kind === 'agent_auth') return `${item.sessionTitle ?? 'Agent'} is blocked — reconnect provider`;
  return 'Activity';
}

function activityAriaLabel(item: ActivityItem, exactTimestamp: string): string {
  return [
    titleFor(item),
    exactTimestamp ? `created ${exactTimestamp}` : null,
    item.snippet,
    item.kind !== 'dm' ? `channel ${item.channelName}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

function isUnread(item: ActivityItem, lastReadEventId: string): boolean {
  const eventId = Number(item.eventId);
  const watermark = Number(lastReadEventId);
  return Number.isSafeInteger(eventId) && Number.isSafeInteger(watermark) && eventId > watermark;
}

export function partitionActivity(items: readonly ActivityItem[]): {
  attention: ActivityItem[];
  history: ActivityItem[];
} {
  const sessionIdsInAttention = new Set<string>();
  const attention: ActivityItem[] = [];
  const history: ActivityItem[] = [];

  for (const item of items) {
    const canPin = ATTENTION_KINDS.has(item.kind) && item.attention;
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

function ActivityRow({
  item,
  attention,
  lastReadEventId,
  onActivate,
}: {
  item: ActivityItem;
  attention: boolean;
  lastReadEventId: string;
  onActivate: (item: ActivityItem) => void;
}) {
  const relativeTimestamp = formatRelativeTimestamp(item.createdAt);
  const exactTimestamp = formatExactTimestamp(item.createdAt);
  const unread = isUnread(item, lastReadEventId);

  return (
    <li>
      <button
        type="button"
        onClick={() => onActivate(item)}
        aria-label={activityAriaLabel(item, exactTimestamp)}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-overlay/70 ${attentionEdgeClass(item, attention)}`}
      >
        <span
          className={`mt-0.5 grid h-6 min-w-8 place-items-center rounded text-2xs font-bold ${kindChipClass(item, attention)}`}
        >
          {KIND_LABEL[item.kind] ?? '•'}
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
          {/* DM channel names are internal keys; the title already names the sender. */}
          {item.kind !== 'dm' && <span className="mt-1 block truncate text-xs text-fg-muted">#{item.channelName}</span>}
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
  onCountsChange,
}: {
  onSelectChannel: (channelId: string) => void;
  onOpenSession: (sessionId: string) => void;
  /** Delivered by Chat's existing WebSocket hub; this component opens no socket. */
  liveEvent?: WireEvent | null;
  /** Increments after a WebSocket reconnect to heal any gap in the feed. */
  refreshKey?: number;
  onCountsChange?: (counts: ActivityCounts) => void;
}) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [lastReadEventId, setLastReadEventId] = useState('0');
  const [counts, setCounts] = useState<ActivityCounts>({ attention: 0, unread: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const lastRefreshKeyRef = useRef(refreshKey);

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
        const counts = { attention: Number(res.counts?.attention) || 0, unread: Number(res.counts?.unread) || 0 };
        setCounts(counts);
        onCountsChange?.(counts);
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

  const activate = async (item: ActivityItem) => {
    onSelectChannel(item.channelId);
    if (
      item.kind !== 'agent_question' &&
      item.kind !== 'session_completed' &&
      item.kind !== 'session_failed' &&
      item.kind !== 'agent_auth'
    ) {
      return;
    }
    const eventId = Number(item.eventId);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return;
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

    const previousCursor = lastReadEventId;
    const optimisticCounts = { attention: counts.attention, unread: 0 };
    setMarkingRead(true);
    setLastReadEventId(String(newestEventId));
    setCounts(optimisticCounts);
    onCountsChange?.(optimisticCounts);
    try {
      const response = await api.markActivityRead(newestEventId);
      setLastReadEventId(response.lastReadEventId);
      // Refetch without blanking the list so state-cleared attention rows and
      // sidebar totals settle from the server's canonical snapshot.
      void load(undefined, true);
    } catch (err) {
      setLastReadEventId(previousCursor);
      setError(err instanceof Error ? err.message : 'Unable to mark activity read');
      void load(undefined, true);
    } finally {
      setMarkingRead(false);
    }
  };

  const { attention, history } = useMemo(() => partitionActivity(items), [items]);

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Loading attention...</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
        <h2 className="text-sm font-bold text-fg">Attention</h2>
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
          Attention couldn&apos;t load. Click to retry.
        </button>
      )}
      {items.length === 0 && !error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-sm font-semibold text-fg">You&apos;re all caught up</p>
          <p className="max-w-md text-sm text-fg-muted">
            Mentions, DMs, agent questions, and agent results will land here when they need you.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {attention.length > 0 && (
            <section aria-labelledby="activity-needs-attention">
              <h2
                id="activity-needs-attention"
                className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-warning-text"
              >
                Needs attention · {attention.length}
              </h2>
              <ul className="divide-y divide-edge border-b border-edge">
                {attention.map((item) => (
                  <ActivityRow
                    key={`${item.kind}:${item.eventId}`}
                    item={item}
                    attention
                    lastReadEventId={lastReadEventId}
                    onActivate={(target) => void activate(target)}
                  />
                ))}
              </ul>
            </section>
          )}
          {history.length > 0 && (
            <section aria-labelledby="activity-history">
              <h2
                id="activity-history"
                className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-fg-muted"
              >
                Activity
              </h2>
              <ul className="divide-y divide-edge">
                {history.map((item) => (
                  <ActivityRow
                    key={`${item.kind}:${item.eventId}`}
                    item={item}
                    attention={false}
                    lastReadEventId={lastReadEventId}
                    onActivate={(target) => void activate(target)}
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
