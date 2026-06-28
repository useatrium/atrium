import type { UserRef, WireEvent } from '@atrium/surface-client';
import { mentionsHandle } from '@atrium/surface-client';
import type { Channel } from './api';
import type { Session } from './sessions/types';

export type ChatNotification =
  | {
      kind: 'message';
      title: string;
      body: string;
      tag: string;
      channelId: string | null;
    }
  | {
      kind: 'session-completed';
      title: string;
      body: string;
      tag: string;
      sessionId: string;
    };

export function notificationForWireEvent(
  event: WireEvent,
  me: UserRef,
  channels: Channel[],
  sessions: Record<string, Session>,
): ChatNotification | null {
  if (event.type === 'message.posted' && event.actorId && event.actorId !== me.id) {
    const text = typeof event.payload?.text === 'string' ? event.payload.text : '';
    const channel = channels.find((c) => c.id === event.channelId);
    if (channel?.muted) return null;
    const isDm = channel?.kind === 'dm' || channel?.kind === 'gdm';
    if (!isDm && !mentionsHandle(text, me.handle)) return null;
    const author = event.author?.displayName ?? 'Someone';
    return {
      kind: 'message',
      title: isDm
        ? `${author} (direct message)`
        : `${author} mentioned you in #${channel?.name ?? 'a channel'}`,
      body: text.slice(0, 140),
      tag: `evt-${event.id}`,
      channelId: event.channelId,
    };
  }

  if (event.type === 'session.completed') {
    const sessionId =
      typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : null;
    const session = sessionId ? sessions[sessionId] : undefined;
    if (!sessionId || !session || session.spawnedBy !== me.id) return null;
    const status = typeof event.payload?.status === 'string' ? event.payload.status : 'done';
    const excerpt =
      typeof event.payload?.resultExcerpt === 'string' ? event.payload.resultExcerpt : '';
    return {
      kind: 'session-completed',
      title: `Agent session ${status}: ${session.title}`,
      body: excerpt.slice(0, 140),
      tag: `evt-${event.id}`,
      sessionId,
    };
  }

  return null;
}
