import { createElement } from 'react';
import type { QuickSwitcherCommand } from '../components/QuickSwitcher';
import {
  deriveSessionGlance,
  isArchivedSession,
  isLiveAgentWork,
  isPendingSessionId,
  isTerminalSessionStatus,
  sessionAttentionKind,
  type Session,
  type SessionGlanceKind,
} from './types';

const GLANCE_DOT_STYLES: Record<SessionGlanceKind, string> = {
  working: 'bg-accent-text-strong',
  needs_you: 'bg-warning-text-strong',
  stalled: 'bg-fg-tertiary',
  done: 'bg-success-text',
  failed: 'bg-danger-text',
  stopped: 'bg-fg-tertiary',
};

function sessionTimestamp(session: Session): number {
  const timestamp = Date.parse(session.completedAt ?? session.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function waitingTimestamp(session: Session, now: number): number {
  const glance = deriveSessionGlance(session, now);
  const timestamp = Date.parse(glance.clock?.mode === 'waiting' ? glance.clock.fromTs : session.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function commandRank(session: Session): number | null {
  if (isPendingSessionId(session.id) || isArchivedSession(session)) return null;
  if (sessionAttentionKind(session) != null) return 0;
  if (isLiveAgentWork(session)) return 1;
  if (isTerminalSessionStatus(session.status)) return 2;
  return null;
}

function channelName(session: Session): string {
  // Session snapshots know the display name, while live wire entities currently
  // only guarantee channelId. Keep the command useful during both hydration paths.
  const displayName = (session as Session & { channelName?: unknown }).channelName;
  return typeof displayName === 'string' && displayName.trim() ? displayName : session.channelId;
}

export function buildAgentCommands(
  sessions: Record<string, Session>,
  onFocusAgent: (id: string) => void,
): QuickSwitcherCommand[] {
  const now = Date.now();
  return Object.values(sessions)
    .map((session) => ({ session, rank: commandRank(session) }))
    .filter((entry): entry is { session: Session; rank: number } => entry.rank != null)
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      const timestampOrder =
        left.rank === 0
          ? waitingTimestamp(left.session, now) - waitingTimestamp(right.session, now)
          : sessionTimestamp(right.session) - sessionTimestamp(left.session);
      return (
        timestampOrder ||
        left.session.title.localeCompare(right.session.title) ||
        left.session.id.localeCompare(right.session.id)
      );
    })
    .map(({ session }) => {
      const glance = deriveSessionGlance(session, now);
      const channel = channelName(session);
      return {
        id: `agent:${session.id}`,
        label: session.title,
        subtitle: `#${channel} · ${glance.label}`,
        group: 'Agents',
        keywords: [session.title, channel, session.harness, 'agent'],
        icon: createElement('span', {
          'aria-hidden': true,
          className: `size-2 rounded-full ${GLANCE_DOT_STYLES[glance.kind]}`,
        }),
        run: () => onFocusAgent(session.id),
      };
    });
}
