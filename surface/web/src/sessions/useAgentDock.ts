import type { Channel } from '@atrium/surface-client';
import {
  deriveSessionGlance,
  isArchivedSession,
  isLiveAgentWork,
  isPendingSessionId,
  isTerminalSessionStatus,
  sessionAttentionKind,
  type Session,
} from './types';

export type AgentDockGroup = {
  key: string;
  label: string;
  kind: 'needs' | 'channel' | 'hibernating' | 'recent';
  channelId?: string;
  sessions: Session[];
};

const RECENT_CAP = 30;

function sessionTimestamp(session: Session): number {
  const timestamp = Date.parse(session.completedAt ?? session.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function newestFirst(left: Session, right: Session): number {
  return sessionTimestamp(right) - sessionTimestamp(left);
}

function blockedTimestamp(session: Session, now: number): number {
  const glance = deriveSessionGlance(session, now);
  const fromTs = glance.clock?.mode === 'waiting' ? glance.clock.fromTs : session.createdAt;
  const timestamp = Date.parse(fromTs);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isDockSession(session: Session): boolean {
  return !isPendingSessionId(session.id) && !isArchivedSession(session);
}

export function agentDockGroups(
  sessions: Record<string, Session>,
  opts: { activeChannelId?: string | null; now: number; channels?: Channel[] },
): AgentDockGroup[] {
  const visible = Object.values(sessions).filter(isDockSession);
  // Attention (question / auth / seat / failed) always leads, and must match
  // `agentDockCounts` exactly — a failed session is terminal but still "needs
  // you" (retry / ask-why), so it belongs here, not in History. Splitting the
  // two would re-introduce the badge-vs-list mismatch this refactor kills.
  const needsYou = visible
    .filter((session) => sessionAttentionKind(session) != null)
    .sort((left, right) => blockedTimestamp(left, opts.now) - blockedTimestamp(right, opts.now));
  const needsYouIds = new Set(needsYou.map((session) => session.id));
  const channelSessions = new Map<string, Session[]>();
  const hibernating: Session[] = [];
  const recent: Session[] = [];

  for (const session of visible) {
    if (needsYouIds.has(session.id)) continue;
    if (isTerminalSessionStatus(session.status)) {
      recent.push(session);
      continue;
    }
    if (isLiveAgentWork(session)) {
      const group = channelSessions.get(session.channelId) ?? [];
      group.push(session);
      channelSessions.set(session.channelId, group);
      continue;
    }
    // There is no durable paused/idle lifecycle state yet. Keep this branch
    // ready for fold-only non-live states without inventing hibernation for a
    // session the client cannot classify confidently.
    if (deriveSessionGlance(session, opts.now).kind === 'stalled') hibernating.push(session);
  }

  const channelNames = new Map(opts.channels?.map((channel) => [channel.id, channel.name]));
  const orderedChannels = [...channelSessions.entries()].sort(([left], [right]) => {
    const activeOrder = Number(right === opts.activeChannelId) - Number(left === opts.activeChannelId);
    if (activeOrder !== 0) return activeOrder;
    return (channelNames.get(left) ?? left).localeCompare(channelNames.get(right) ?? right);
  });

  const groups: AgentDockGroup[] = [];
  if (needsYou.length > 0) groups.push({ key: 'needs-you', label: 'Needs you', kind: 'needs', sessions: needsYou });
  for (const [channelId, groupedSessions] of orderedChannels) {
    groups.push({
      key: `channel:${channelId}`,
      label: channelNames.get(channelId) ?? channelId,
      kind: 'channel',
      channelId,
      sessions: groupedSessions.sort(newestFirst),
    });
  }
  if (hibernating.length > 0) {
    groups.push({
      key: 'hibernating',
      label: 'Hibernating',
      kind: 'hibernating',
      sessions: hibernating.sort(newestFirst),
    });
  }
  if (recent.length > 0) {
    groups.push({
      key: 'recent',
      label: 'History',
      kind: 'recent',
      sessions: recent.sort(newestFirst).slice(0, RECENT_CAP),
    });
  }
  return groups;
}

export function agentDockCounts(sessions: Record<string, Session>): {
  needsYou: number;
  live: number;
  review: number;
} {
  const needsYouIds = new Set<string>();
  const liveIds = new Set<string>();
  const reviewIds = new Set<string>();

  for (const session of Object.values(sessions)) {
    if (!isDockSession(session)) continue;
    if (sessionAttentionKind(session) != null) {
      needsYouIds.add(session.id);
      continue;
    }
    if (isLiveAgentWork(session)) {
      liveIds.add(session.id);
      continue;
    }
    if (isTerminalSessionStatus(session.status) && !needsYouIds.has(session.id)) reviewIds.add(session.id);
  }

  return { needsYou: needsYouIds.size, live: liveIds.size, review: reviewIds.size };
}
