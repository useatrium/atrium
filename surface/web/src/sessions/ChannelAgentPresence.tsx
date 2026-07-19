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
    <span data-testid="channel-agent-presence" className="flex min-w-0 items-center gap-1 whitespace-nowrap">
      <span className="shrink-0 text-2xs tabular-nums text-fg-muted">
        {presentUsers.length} {presentUsers.length === 1 ? 'person' : 'people'}
      </span>
      {liveAgentCount > 0 && (
        <button
          type="button"
          onClick={() => onOpenDock(channelId)}
          className="min-w-0 truncate text-2xs tabular-nums text-fg-muted hover:text-fg-body focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          · {liveAgentCount} {liveAgentCount === 1 ? 'agent' : 'agents'} here <span aria-hidden="true">→</span>
        </button>
      )}
    </span>
  );
}
