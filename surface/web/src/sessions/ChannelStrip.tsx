import { useMemo, useState } from 'react';
import { formatOutcome } from '@atrium/surface-client';
import {
  formatDurationUnits,
  isArchivedSession,
  isPendingSessionId,
  isTerminalSessionStatus,
  type Session,
} from './types';
import { sessionElapsedMs, useNow } from './SessionCard';

const ROW_CAP = 5;
const REVIEW_WINDOW_MS = 48 * 60 * 60 * 1000;

type Bucket = 'needs' | 'running' | 'review';

type StripSession = {
  session: Session;
  bucket: Bucket;
};

function needsAttention(session: Session): boolean {
  return (
    session.pendingQuestion != null || session.providerAuthRequired != null || session.pendingSeatRequests.length > 0
  );
}

function completedRecently(session: Session, now: number): boolean {
  if (!session.completedAt) return false;
  const completedAt = Date.parse(session.completedAt);
  return Number.isFinite(completedAt) && completedAt >= now - REVIEW_WINDOW_MS;
}

function sortNewest(a: Session, b: Session): number {
  return Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt);
}

/** Longest-waiting blocker first — same order as the sidebar and Inbox. */
function sortLongestBlocked(a: Session, b: Session): number {
  const blockedAt = (s: Session) => Date.parse(s.pendingQuestion?.askedAt ?? s.createdAt);
  return blockedAt(a) - blockedAt(b);
}

function channelSessions(channelId: string | null, sessions: Record<string, Session>, now: number): StripSession[] {
  if (!channelId) return [];
  const buckets: Record<Bucket, Session[]> = { needs: [], running: [], review: [] };
  for (const session of Object.values(sessions)) {
    if (session.channelId !== channelId || isArchivedSession(session) || isPendingSessionId(session.id)) continue;
    if (isTerminalSessionStatus(session.status)) {
      // Client session state has no completion-unread marker yet. Keep recent
      // terminal work visible until the server provides that per-user signal.
      if (completedRecently(session, now)) buckets.review.push(session);
    } else if (needsAttention(session)) {
      buckets.needs.push(session);
    } else {
      buckets.running.push(session);
    }
  }
  return (['needs', 'running', 'review'] as const).flatMap((bucket) =>
    buckets[bucket].sort(bucket === 'needs' ? sortLongestBlocked : sortNewest).map((session) => ({ session, bucket })),
  );
}

function countLabel(count: number, label: string): string {
  return `${count} ${label}`;
}

export function ChannelStrip({
  channelId,
  sessions,
  onOpenSession,
  onOpenInbox,
}: {
  channelId: string | null;
  sessions: Record<string, Session>;
  onOpenSession: (sessionId: string) => void;
  onOpenInbox: () => void;
}) {
  const now = useNow(Object.values(sessions).some((session) => !isTerminalSessionStatus(session.status)));
  const [expandedByChannel, setExpandedByChannel] = useState<Record<string, boolean>>({});
  const rows = useMemo(() => channelSessions(channelId, sessions, now), [channelId, now, sessions]);
  const counts = useMemo(
    () => ({
      needs: rows.filter((row) => row.bucket === 'needs').length,
      running: rows.filter((row) => row.bucket === 'running').length,
      review: rows.filter((row) => row.bucket === 'review').length,
    }),
    [rows],
  );
  if (!channelId || rows.length === 0) return null;

  const expanded = expandedByChannel[channelId] === true;
  const summary = [
    counts.needs > 0 ? countLabel(counts.needs, 'needs you') : null,
    counts.running > 0 ? countLabel(counts.running, 'running') : null,
    counts.review > 0 ? countLabel(counts.review, 'to review') : null,
  ].filter((part): part is string => part != null);
  const countSegments = [
    counts.needs > 0 ? { key: 'needs', glyph: '⚠', count: counts.needs, label: 'needs you', warning: true } : null,
    counts.running > 0 ? { key: 'running', glyph: '●', count: counts.running, label: 'running', warning: false } : null,
    counts.review > 0 ? { key: 'review', glyph: '✓', count: counts.review, label: 'to review', warning: false } : null,
  ].filter((segment): segment is NonNullable<typeof segment> => segment != null);
  const visibleRows = rows.slice(0, ROW_CAP);
  const hiddenRows = rows.length - visibleRows.length;

  return (
    <fieldset
      aria-label="Agent work in this channel"
      data-testid="channel-strip"
      tabIndex={expanded ? 0 : -1}
      onKeyDown={(event) => {
        if (expanded && event.key === 'Escape') {
          event.preventDefault();
          setExpandedByChannel((current) => ({ ...current, [channelId]: false }));
        }
      }}
      className="m-0 min-w-0 shrink-0 border-0 border-t border-edge bg-surface p-0"
    >
      {expanded && (
        <div data-testid="channel-strip-panel" className="border-b border-edge px-2 py-1.5">
          <div className="space-y-0.5">
            {visibleRows.map(({ session, bucket }) => {
              const question = session.pendingQuestion?.questions[0]?.question;
              const auth = session.providerAuthRequired;
              const detail =
                bucket === 'needs'
                  ? (question ?? auth?.message ?? 'A collaborator is waiting for a seat')
                  : bucket === 'running'
                    ? `Running ${formatDurationUnits(Math.max(0, sessionElapsedMs(session, now)))}`
                    : `${formatOutcome(session.status, Math.max(0, sessionElapsedMs(session, now)))}${
                        session.resultText ? ` · ${session.resultText}` : ''
                      }`;
              const pointer = question ? 'Answer →' : auth ? 'Reconnect →' : 'Respond →';
              const glyph =
                bucket === 'needs' ? '⚠' : bucket === 'running' ? '●' : session.status === 'completed' ? '✓' : '✕';
              return (
                <button
                  type="button"
                  key={session.id}
                  data-testid={`channel-strip-row-${session.id}`}
                  onClick={() => onOpenSession(session.id)}
                  className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left hover:bg-surface-overlay focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                >
                  <span
                    className={bucket === 'needs' ? 'shrink-0 text-warning-text-strong' : 'shrink-0 text-fg-muted'}
                    aria-hidden="true"
                  >
                    {glyph}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-fg">{session.title}</span>
                    <span className="block truncate text-2xs text-fg-muted">{detail}</span>
                  </span>
                  {bucket === 'needs' && (
                    <span className="shrink-0 text-2xs font-semibold text-warning-text-strong">{pointer}</span>
                  )}
                </button>
              );
            })}
          </div>
          {hiddenRows > 0 && (
            <button
              type="button"
              onClick={onOpenInbox}
              className="mt-1 w-full rounded px-2 py-1 text-left text-xs font-medium text-fg-muted hover:bg-surface-overlay hover:text-fg"
            >
              {hiddenRows} more → Inbox
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Agent work in this channel: ${summary.join(', ')}`}
        onClick={() => setExpandedByChannel((current) => ({ ...current, [channelId]: !expanded }))}
        className="flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden px-3 text-xs text-fg-muted hover:bg-surface-overlay focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        {countSegments.map((segment, index) => (
          <span
            key={segment.key}
            className={`shrink-0 whitespace-nowrap ${segment.warning ? 'text-warning-text-strong' : ''}`}
          >
            {index > 0 && <span className="mr-2 text-fg-faint">·</span>}
            {segment.glyph} {segment.count}
            <span className="hidden sm:inline"> {segment.label}</span>
          </span>
        ))}
      </button>
    </fieldset>
  );
}
