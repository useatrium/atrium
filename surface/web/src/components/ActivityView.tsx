import { useCallback, useEffect, useState } from 'react';
import type { ActivityItem } from '@atrium/surface-client';
import { api } from '../api';

const KIND_LABEL: Record<ActivityItem['kind'], string> = {
  mention: '@',
  dm: 'DM',
  agent_question: '?',
  session_completed: 'OK',
};

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function titleFor(item: ActivityItem): string {
  if (item.kind === 'mention') return `${item.actorName ?? 'Someone'} mentioned you`;
  if (item.kind === 'dm') return `${item.actorName ?? 'Someone'} sent a DM`;
  if (item.kind === 'agent_question') return 'Agent needs your input';
  return 'Agent session completed';
}

export function ActivityView({
  onSelectChannel,
  onOpenSession,
}: {
  onSelectChannel: (channelId: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await api.getActivity(cursor);
      setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load activity');
    } finally {
      if (cursor) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activate = async (item: ActivityItem) => {
    onSelectChannel(item.channelId);
    if (item.kind !== 'agent_question' && item.kind !== 'session_completed') return;
    const eventId = Number(item.eventId);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return;
    try {
      const { events } = await api.messages(item.channelId, {
        afterId: eventId - 1,
        limit: 1,
      });
      const event = events.find((candidate) => candidate.id === eventId);
      const sessionId = event && typeof event.payload?.sessionId === 'string'
        ? event.payload.sessionId
        : null;
      if (sessionId) onOpenSession(sessionId);
    } catch (err) {
      console.warn('failed to resolve activity session', err);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
        Loading activity...
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="border-b border-edge px-4 py-3">
        <h2 className="text-sm font-bold text-fg">Activity</h2>
      </div>
      {error && (
        <button
          type="button"
          onClick={() => void load()}
          className="mx-4 mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-left text-sm text-danger hover:bg-danger/15"
        >
          Activity failed. Click to retry.
        </button>
      )}
      {items.length === 0 && !error ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-fg-muted">
          You&apos;re all caught up.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul className="divide-y divide-edge">
            {items.map((item) => (
              <li key={`${item.kind}:${item.eventId}`}>
                <button
                  type="button"
                  onClick={() => void activate(item)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-overlay/70"
                >
                  <span className="mt-0.5 grid h-6 min-w-8 place-items-center rounded bg-surface-raised text-2xs font-bold text-fg-muted">
                    {KIND_LABEL[item.kind]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold text-fg">{titleFor(item)}</span>
                      <span className="shrink-0 text-2xs text-fg-faint">{relativeTime(item.createdAt)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-fg-secondary">{item.snippet}</span>
                    {/* DM channel names are internal keys; the title already names the sender. */}
                    {item.kind !== 'dm' && (
                      <span className="mt-1 block truncate text-xs text-fg-muted">#{item.channelName}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
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
