import { useMemo } from 'react';
import { attachedSessionForRoot, type AppState, type ChannelTimeline, type Session } from '@atrium/surface-client';

export type ConversationMode = 'thread' | 'work';

export function useConversationSelection({
  openThreadRootId,
  paneSession,
  routeSessionId,
  sessions,
  timeline,
}: {
  openThreadRootId: number | null;
  paneSession: Session | null;
  routeSessionId: string | null | undefined;
  sessions: AppState['sessions'];
  timeline: ChannelTimeline;
}) {
  return useMemo(() => {
    const openThreadRoot =
      openThreadRootId != null ? (timeline.main.find((message) => message.id === openThreadRootId) ?? null) : null;
    const attachedThreadSession = openThreadRoot
      ? attachedSessionForRoot(sessions, openThreadRoot, openThreadRoot.channelId)
      : undefined;
    // The conversation's identity must not depend on the mode: during a
    // thread→work route flip paneSession settles a render later, and falling
    // back to `undefined` would flip ConversationPanel's key (remount + a second
    // SSE). The thread's attached session IS the same conversation — use it in
    // both modes.
    const conversationSession = paneSession ?? attachedThreadSession;
    const conversationMode: ConversationMode = routeSessionId ? 'work' : 'thread';

    return { openThreadRoot, attachedThreadSession, conversationSession, conversationMode };
  }, [openThreadRootId, paneSession, routeSessionId, sessions, timeline.main]);
}
