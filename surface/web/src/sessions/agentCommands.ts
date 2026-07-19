import { channelLabel, type Channel } from '@atrium/surface-client';
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

/**
 * The decorated channel label for a command subtitle — the same resolution the
 * dock rows use (channelId → name), so the palette never leaks a raw UUID.
 * DMs/GDMs render their member label; #channels their name; unknown channels
 * fall back to the session snapshot's name, then a neutral placeholder.
 */
function channelDisplay(session: Session, channels: ReadonlyMap<string, Channel>, meId: string): string {
  const channel = channels.get(session.channelId);
  if (channel) {
    if (channel.kind === 'dm' || channel.kind === 'gdm') return channelLabel(channel, meId);
    return `#${channel.name}`;
  }
  // Live wire snapshots sometimes carry the display name before the channel
  // list hydrates; prefer it over the opaque id, and never surface the id.
  const snapshot = (session as Session & { channelName?: unknown }).channelName;
  if (typeof snapshot === 'string' && snapshot.trim()) return `#${snapshot.trim()}`;
  return '#channel';
}

export function buildAgentCommands(
  sessions: Record<string, Session>,
  channels: Channel[],
  meId: string,
  onFocusAgent: (id: string) => void,
): QuickSwitcherCommand[] {
  const now = Date.now();
  const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
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
      const channel = channelDisplay(session, channelMap, meId);
      return {
        id: `agent:${session.id}`,
        label: session.title,
        subtitle: `${channel} · ${glance.label}`,
        group: 'Agents',
        keywords: [session.title, channel.replace(/^#/, ''), session.harness, 'agent'],
        icon: createElement('span', {
          'aria-hidden': true,
          className: `size-2 rounded-full ${GLANCE_DOT_STYLES[glance.kind]}`,
        }),
        run: () => onFocusAgent(session.id),
      };
    });
}
