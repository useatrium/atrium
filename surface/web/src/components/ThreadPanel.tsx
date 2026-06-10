import { useLayoutEffect, useRef } from 'react';
import type { ChatMessage } from '../state';
import type { Session } from '../sessions/types';
import { buildTimelineItems } from '../util';
import { Composer } from './Composer';
import { MessageRow } from './MessageRow';

export function ThreadPanel({
  root,
  replies,
  loaded,
  sessions,
  spectators,
  onClose,
  onSend,
  onOpenSession,
  onRetry,
}: {
  root: ChatMessage;
  replies: ChatMessage[];
  /** The thread fetch resolved — gates the empty state vs. the loading hint. */
  loaded: boolean;
  sessions: Record<string, Session>;
  spectators: Record<string, number>;
  onClose: () => void;
  onSend: (text: string) => void;
  onOpenSession: (sessionId: string) => void;
  onRetry: (message: ChatMessage) => void;
}) {
  const sessionFor = (m: ChatMessage) =>
    m.sessionId != null ? sessions[m.sessionId] : undefined;
  const spectatorsFor = (m: ChatMessage) =>
    m.sessionId != null ? (spectators[m.sessionId] ?? 0) : 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = replies.length;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  const items = buildTimelineItems(replies);

  return (
    <aside className="flex w-[min(380px,38vw)] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/60">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
        <div className="text-sm font-semibold text-zinc-100">
          Thread
          <span className="ml-2 text-xs font-normal text-zinc-500">
            {root.replyCount} {root.replyCount === 1 ? 'reply' : 'replies'}
          </span>
        </div>
        <button
          onClick={onClose}
          title="Close thread"
          aria-label="Close thread"
          className="rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          ✕
        </button>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
        <MessageRow
          message={root}
          grouped={false}
          inThread
          session={sessionFor(root)}
          spectators={spectatorsFor(root)}
          onOpenSession={onOpenSession}
          onRetry={onRetry}
        />
        <div className="my-2 flex items-center gap-2 px-4">
          <div className="h-px flex-1 bg-zinc-800" />
          <span className="text-[10px] uppercase tracking-wide text-zinc-600">replies</span>
          <div className="h-px flex-1 bg-zinc-800" />
        </div>
        {items.map((item) =>
          item.kind === 'day' ? null : (
            <MessageRow
              key={item.key}
              message={item.message!}
              grouped={item.grouped ?? false}
              inThread
              session={sessionFor(item.message!)}
              spectators={spectatorsFor(item.message!)}
              onOpenSession={onOpenSession}
              onRetry={onRetry}
            />
          ),
        )}
        {replies.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-zinc-500">
            {loaded ? 'No replies yet. Start the thread.' : 'Loading replies…'}
          </div>
        )}
      </div>
      <Composer placeholder="Reply…" onSend={onSend} autoFocus agentAware />
    </aside>
  );
}
