import { memo, useMemo, type CSSProperties } from 'react';
import { attachedSessionForRoot } from '@atrium/surface-client';
import { isTerminalSessionStatus, type Session } from './types';
import { ThreadPanelContent, type ThreadPanelProps } from '../components/ThreadPanel';
import { SessionPaneContent, type SessionPaneProps } from './SessionPane';
import { useSessionStream } from './useSessionStream';
import { Tooltip } from '../components/a11y';
import { XIcon } from '../components/icons';

export type ConversationPanelMode = 'thread' | 'work';

export interface ConversationPanelProps {
  mode: ConversationPanelMode;
  thread?: ThreadPanelProps;
  session?: SessionPaneProps;
  pending?: {
    sessionId: string;
    error: boolean;
    onClose: () => void;
    layout: 'split' | 'focus';
    sizing: { className: string; style: CSSProperties | undefined };
  };
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
function ConversationPanelImpl({ mode, thread, session, pending }: ConversationPanelProps) {
  const attachedThreadSession = useMemo(() => threadSession(thread), [thread]);
  const conversationSession = session?.session ?? attachedThreadSession ?? null;
  const sessionStream = useSessionStream(
    conversationSession?.id ?? null,
    conversationSession != null && !isTerminalSessionStatus(conversationSession.status),
  );
  const threadMatchesSession =
    thread != null &&
    (session == null || attachedThreadSession == null || attachedThreadSession.id === session.session.id);

  if (!session && !thread && pending) {
    const fullWidth = pending.layout === 'focus';
    return (
      <aside
        key={pending.sessionId}
        className={`flex min-w-0 flex-col border-l border-edge bg-surface ${
          fullWidth ? 'flex-1' : `shrink-0 ${pending.sizing.className}`
        }`}
        style={fullWidth ? undefined : pending.sizing.style}
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-4">
          <h2 className="text-sm font-semibold text-fg">Session</h2>
          <Tooltip content="Close session details">
            <button
              type="button"
              onClick={pending.onClose}
              aria-label="Close session details"
              className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
            >
              <XIcon />
            </button>
          </Tooltip>
        </header>
        {pending.error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
            <div className="text-sm font-medium text-fg-secondary">Agent not found</div>
            <div className="text-xs text-fg-muted">It may have been removed, or the link is wrong.</div>
            <button
              type="button"
              onClick={pending.onClose}
              className="mt-2 rounded-md border border-edge-strong px-3 py-1 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Loading session…</div>
        )}
      </aside>
    );
  }

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
