import type { UserRef as PresenceUser } from '@atrium/surface-client';
import { isLiveAgentWork, type Session } from './types';

export type ChannelAgentPresenceProps = {
  channelId: string;
  sessions: Record<string, Session>;
  presentUsers: PresenceUser[];
  now: number;
  onOpenDock: (channelId: string) => void;
};

export function ChannelAgentPresence({
  channelId,
  sessions,
  presentUsers,
  now: _now,
  onOpenDock,
}: ChannelAgentPresenceProps) {
  const liveAgentCount = Object.values(sessions).filter(
    (session) => session.channelId === channelId && isLiveAgentWork(session),
  ).length;
  return (
    <span data-testid="channel-agent-presence">
      <button
        type="button"
        onClick={() => onOpenDock(channelId)}
        className="text-2xs tabular-nums text-fg-muted hover:text-fg-body"
      >
        {presentUsers.length} people · {liveAgentCount} agents here →
      </button>
    </span>
  );
}
