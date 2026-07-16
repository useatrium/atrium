import { memo, useMemo } from 'react';
import { attachedSessionForRoot } from '@atrium/surface-client';
import { isTerminalSessionStatus, type Session } from './types';
import { ThreadPanelContent, type ThreadPanelProps } from '../components/ThreadPanel';
import { SessionPaneContent, type SessionPaneProps } from './SessionPane';
import { useSessionStream } from './useSessionStream';

export type ConversationPanelMode = 'thread' | 'work';

export interface ConversationPanelProps {
  mode: ConversationPanelMode;
  thread?: ThreadPanelProps;
  session?: SessionPaneProps;
}

function threadSession(thread: ThreadPanelProps | undefined): Session | undefined {
  if (!thread) return undefined;
  return attachedSessionForRoot(thread.sessions, thread.root, thread.root.channelId);
}

/**
 * The route changes the panel's mode, never its identity. Both mode bodies stay
 * mounted so their scroll containers and dock controls retain local state;
 * this owner is the sole in-app SSE subscriber for the active conversation.
 */
function ConversationPanelImpl({ mode, thread, session }: ConversationPanelProps) {
  const attachedThreadSession = useMemo(() => threadSession(thread), [thread]);
  const conversationSession = session?.session ?? attachedThreadSession ?? null;
  const sessionStream = useSessionStream(
    conversationSession?.id ?? null,
    conversationSession != null && !isTerminalSessionStatus(conversationSession.status),
  );
  const threadMatchesSession =
    thread != null &&
    (session == null || attachedThreadSession == null || attachedThreadSession.id === session.session.id);

  return (
    <>
      {threadMatchesSession && (
        <div className={mode === 'thread' ? 'contents' : 'hidden'} aria-hidden={mode !== 'thread'}>
          <ThreadPanelContent {...thread} sessionStream={sessionStream} visible={mode === 'thread'} />
        </div>
      )}
      {session && (
        <div className={mode === 'work' ? 'contents' : 'hidden'} aria-hidden={mode !== 'work'}>
          <SessionPaneContent {...session} sessionStream={sessionStream} visible={mode === 'work'} />
        </div>
      )}
    </>
  );
}

export const ConversationPanel = memo(ConversationPanelImpl);
