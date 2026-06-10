import { useLayoutEffect, useRef } from 'react';
import type { ChatMessage } from '../state';
import type { Session } from '../sessions/types';
import { buildTimelineItems } from '../util';
import { MessageRow } from './MessageRow';

export function Timeline({
  messages,
  hasMoreBefore,
  sessions,
  spectators,
  onLoadEarlier,
  onOpenThread,
  onOpenSession,
  onRetry,
}: {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  sessions: Record<string, Session>;
  spectators: Record<string, number>;
  onLoadEarlier: () => void;
  onOpenThread: (rootEventId: number) => void;
  onOpenSession: (sessionId: string) => void;
  onRetry: (message: ChatMessage) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const prevHeightRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string>('');

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
    prevHeightRef.current = containerRef.current?.scrollHeight ?? null;
    onLoadEarlier();
  };

  return (
    <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-y-auto pb-4 pt-2">
      {hasMoreBefore && (
        <div className="flex justify-center py-2">
          <button
            onClick={loadEarlier}
            className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            Load earlier messages
          </button>
        </div>
      )}
      {items.length === 0 && (
        <div className="flex h-full items-center justify-center text-sm text-zinc-600">
          No messages yet. Say something.
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
            onOpenThread={onOpenThread}
            onOpenSession={onOpenSession}
            onRetry={onRetry}
          />
        ),
      )}
    </div>
  );
}
