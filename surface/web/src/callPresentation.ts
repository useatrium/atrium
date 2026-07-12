import type { CallWire, UserRef } from '@atrium/surface-client';
import { channelLabel } from '@atrium/surface-client';
import type { Channel } from './api';

function fallbackUser(id: string): UserRef {
  return { id, handle: id, displayName: id };
}

export function userForCall(call: CallWire, channels: Channel[], userId: string): UserRef {
  return (
    call.participants.find((u) => u.id === userId) ??
    channels.find((c) => c.id === call.channelId)?.members?.find((u) => u.id === userId) ??
    fallbackUser(userId)
  );
}

export function labelForCallChannel(call: CallWire, channels: Channel[], meId: string): string {
  const channel = channels.find((c) => c.id === call.channelId);
  if (!channel) return 'Unknown channel';
  return channel.kind === 'private' ? `#${channel.name}` : channelLabel(channel, meId);
}
