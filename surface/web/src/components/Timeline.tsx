import { useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../state';
import type { Session } from '../sessions/types';
import { buildTimelineItems } from '../util';
import { MessageRow } from './MessageRow';

export function Timeline({
  messages,
  loaded,
  hasMoreBefore,
  sessions,
  spectators,
  meId,
  meHandle,
  editRequestId,
  onEditRequestHandled,
  onLoadEarlier,
  onOpenThread,
  onOpenSession,
  onRetry,
  onEdit,
  onDelete,
  onReact,
}: {
  messages: ChatMessage[];
  /** History fetched at least once — gates the empty state vs. the skeleton. */
  loaded: boolean;
  hasMoreBefore: boolean;
  sessions: Record<string, Session>;
  spectators: Record<string, number>;
  meId?: string;
  meHandle?: string;
  /** Message id the composer's up-arrow asked to edit. */
  editRequestId?: number | null;
  onEditRequestHandled?: () => void;
  onLoadEarlier: () => Promise<void>;
  onOpenThread: (rootEventId: number) => void;
  onOpenSession: (sessionId: string) => void;
  onRetry: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage, text: string) => Promise<void>;
  onDelete?: (message: ChatMessage) => Promise<void>;
  onReact?: (message: ChatMessage, emoji: string) => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const prevHeightRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string>('');
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const items = buildTimelineItems(messages);
  const lastKey = items.at(-1)?.key ?? '';

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Keep pinned to bottom for new messages; preserve position when older
  // history is prepended.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (prevHeightRef.current != null) {
      el.scrollTop += el.scrollHeight - prevHeightRef.current;
      prevHeightRef.current = null;
      return;
    }
    if (stickRef.current && lastKey !== lastKeyRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    lastKeyRef.current = lastKey;
  });

  const loadEarlier = () => {
    if (loadingEarlier) return;
    prevHeightRef.current = containerRef.current?.scrollHeight ?? null;
    setLoadingEarlier(true);
    onLoadEarlier().finally(() => setLoadingEarlier(false));
  };

  return (
    <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-y-auto pb-4 pt-2">
      {hasMoreBefore && (
        <div className="flex justify-center py-2">
          <button
            onClick={loadEarlier}
            disabled={loadingEarlier}
            className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:text-zinc-600"
          >
            {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
          </button>
        </div>
      )}
      {!loaded && items.length === 0 && <TimelineSkeleton />}
      {loaded && items.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-sm text-zinc-500">
          <span>No messages yet. Say something.</span>
          <span className="text-xs text-zinc-600">
            Or type{' '}
            <code className="rounded bg-zinc-800/80 px-1 py-0.5 text-[11px] text-zinc-400">
              @agent &lt;task&gt;
            </code>{' '}
            to put an agent on it.
          </span>
        </div>
      )}
      {items.map((item) =>
        item.kind === 'day' ? (
          <div key={item.key} className="my-3 flex items-center gap-3 px-4">
            <div className="h-px flex-1 bg-zinc-800" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              {item.label}
            </span>
            <div className="h-px flex-1 bg-zinc-800" />
          </div>
        ) : (
          <MessageRow
            key={item.key}
            message={item.message!}
            grouped={item.grouped ?? false}
            session={
              item.message!.sessionId != null ? sessions[item.message!.sessionId] : undefined
            }
            spectators={
              item.message!.sessionId != null ? (spectators[item.message!.sessionId] ?? 0) : 0
            }
            meId={meId}
            meHandle={meHandle}
            editRequested={editRequestId != null && item.message!.id === editRequestId}
            onEditRequestHandled={onEditRequestHandled}
            onOpenThread={onOpenThread}
            onOpenSession={onOpenSession}
            onRetry={onRetry}
            onEdit={onEdit}
            onDelete={onDelete}
            onReact={onReact}
          />
        ),
      )}
    </div>
  );
}

/** Structural placeholder while the first history page is in flight. */
function TimelineSkeleton() {
  return (
    <div aria-hidden className="animate-pulse">
      {[0, 1, 2].map((i) => (
        <div key={i} className="mt-2 flex gap-3 px-4 py-0.5">
          <div className="size-8 shrink-0 rounded-md bg-zinc-800/80" />
          <div className="min-w-0 flex-1">
            <div className="h-3 w-28 rounded bg-zinc-800/80" />
            <div className="mt-1.5 h-3 rounded bg-zinc-800/50" style={{ width: `${60 - i * 15}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
