import { useEffect, useRef } from 'react';
import type { CallWire, UserRef } from '@atrium/surface-client';
import type { RemoteTrack } from 'livekit-client';
import { Avatar } from './Avatar';
import { MicIcon, MicOffIcon, PhoneOffIcon } from './icons';
import type { ActiveCallState } from '../useCall';

function uniqueUsers(users: UserRef[]): UserRef[] {
  return users.reduce<UserRef[]>((acc, participant) => {
    if (acc.some((p) => p.id === participant.id)) return acc;
    return [...acc, participant];
  }, []);
}

function RemoteAudio({ track }: { track: RemoteTrack }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}

export function IncomingCallBanner({
  call,
  caller,
  channelName,
  answering,
  onAccept,
  onDecline,
}: {
  call: CallWire;
  caller: UserRef;
  channelName: string;
  answering: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-edge bg-surface-raised/80 px-4 py-2">
      <Avatar name={caller.displayName} seed={caller.id} size={24} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg">{caller.displayName} is calling</div>
        <div className="truncate text-2xs text-fg-muted">{channelName}</div>
      </div>
      <button
        onClick={onDecline}
        className="rounded-md border border-edge-strong px-3 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg"
      >
        Decline
      </button>
      <button
        onClick={onAccept}
        disabled={answering}
        className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:bg-surface-overlay disabled:text-fg-muted"
      >
        {answering ? 'Joining…' : 'Accept'}
      </button>
      <span className="sr-only">Call id {call.id}</span>
    </div>
  );
}

export function ChannelCallStrip({
  call,
  caller,
  channelName,
  meId,
  joining,
  onJoin,
  onDecline,
}: {
  call: CallWire;
  caller: UserRef;
  channelName: string;
  meId: string;
  joining: boolean;
  onJoin: () => void;
  onDecline: () => void;
}) {
  const participants = uniqueUsers(call.participants);
  const visibleParticipants = participants.length > 0 ? participants : [caller];
  const participantNames = participants
    .map((participant) => (participant.id === meId ? 'You' : participant.displayName))
    .join(', ');
  const isRinging = call.status === 'ringing';
  const viewerIsInitiator = call.initiatorId === meId;
  const viewerInCall = participants.some((participant) => participant.id === meId);
  const canDecline = isRinging && !viewerIsInitiator;
  const actionLabel = joining
    ? viewerInCall
      ? 'Rejoining…'
      : 'Joining…'
    : viewerInCall
      ? 'Rejoin'
      : canDecline
        ? 'Accept'
        : 'Join';
  const title = isRinging
    ? viewerIsInitiator
      ? 'Call ringing'
      : `${caller.displayName} is calling`
    : 'Live call';
  const detail = isRinging
    ? channelName
    : participantNames || `${visibleParticipants.length} in call`;

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-edge bg-surface-raised/60 px-4 py-2">
      <div className="flex -space-x-1.5">
        {visibleParticipants.slice(0, 3).map((participant) => (
          <div key={participant.id} className="rounded-md ring-2 ring-surface-raised">
            <Avatar name={participant.displayName} seed={participant.id} size={24} />
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium text-fg">{title}</div>
          {!isRinging && (
            <div className="hidden shrink-0 text-2xs tabular-nums text-fg-muted sm:block">
              {participants.length || visibleParticipants.length} in call
            </div>
          )}
        </div>
        <div className="truncate text-2xs text-fg-muted">{detail}</div>
      </div>
      {canDecline && (
        <button
          onClick={onDecline}
          className="rounded-md border border-edge-strong px-3 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg"
        >
          Decline
        </button>
      )}
      <button
        onClick={onJoin}
        disabled={joining}
        className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:bg-surface-overlay disabled:text-fg-muted"
      >
        {actionLabel}
      </button>
      <span className="sr-only">Call id {call.id}</span>
    </div>
  );
}

export function CallNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-warning-border/30 bg-warning-tint/20 px-4 py-1 text-2xs text-warning-text"
    >
      <span>{message}</span>
      <button
        onClick={onDismiss}
        className="rounded px-1.5 py-px font-medium text-warning-text-strong hover:bg-warning-tint/50"
      >
        Dismiss
      </button>
    </div>
  );
}

export function InCallPanel({
  call,
  meId,
  channelName,
  onToggleMute,
  onLeave,
}: {
  call: ActiveCallState;
  meId: string;
  channelName: string;
  onToggleMute: () => void;
  onLeave: () => void;
}) {
  const participants = uniqueUsers(call.participants);
  const participantCount = participants.length;
  const remoteCount = participants.filter((p) => p.id !== meId).length;
  const label =
    call.phase === 'connecting'
      ? 'Connecting…'
      : call.call.status === 'ringing' && remoteCount === 0
        ? 'Calling…'
        : call.phase === 'ended'
          ? 'Call ended'
          : 'In call';

  return (
    <div className="shrink-0 border-b border-edge bg-surface-raised/60 px-4 py-2">
      {call.remoteAudioTracks.map(({ key, track }) => (
        <RemoteAudio key={key} track={track} />
      ))}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold text-fg">{label}</span>
            <span className="truncate text-2xs text-fg-muted">{channelName}</span>
            {participantCount > 2 && (
              <span className="text-2xs tabular-nums text-fg-muted">
                {participantCount} in call
              </span>
            )}
          </div>
          {call.error ? (
            <div className="mt-0.5 text-2xs text-danger-text">{call.error}</div>
          ) : (
            <div className="mt-1 grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-1.5">
              {participants.map((participant) => {
                const speaking = call.activeSpeakerIds.has(participant.id);
                return (
                  <span
                    key={participant.id}
                    className={`inline-flex min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-2xs ${
                      speaking
                        ? 'border-accent-border bg-accent-hover/15 text-accent-text-strong'
                        : 'border-edge bg-surface text-fg-secondary'
                    }`}
                  >
                    <Avatar name={participant.displayName} seed={participant.id} size={16} />
                    <span className="truncate">
                      {participant.displayName}
                      {participant.id === meId ? ' (you)' : ''}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onToggleMute}
            disabled={call.phase === 'ended'}
            title={call.muted ? 'Unmute microphone' : 'Mute microphone'}
            aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'}
            className={`rounded-md border px-2 py-1 text-xs font-medium ${
              call.muted
                ? 'border-warning-border bg-warning-tint/30 text-warning-text hover:bg-warning-tint/50'
                : 'border-edge-strong text-fg-secondary hover:bg-surface-overlay hover:text-fg'
            } disabled:cursor-default disabled:border-edge disabled:text-fg-faint`}
          >
            {call.muted ? <MicOffIcon size={15} /> : <MicIcon size={15} />}
          </button>
          <button
            onClick={onLeave}
            className="inline-flex items-center gap-1.5 rounded-md border border-danger-border/70 px-3 py-1 text-xs font-medium text-danger-text hover:bg-danger-tint/40"
          >
            <PhoneOffIcon size={15} />
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
