import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import type { Session } from '../sessions/types';
import { buildTimelineItems } from '@atrium/surface-client';
import { ChevronDownIcon } from './icons';
import { MessageRow } from './MessageRow';

const UNREAD_DIVIDER_SELECTOR = '[data-unread-divider]';
const BOTTOM_SLOP_PX = 80;

export function Timeline({
  messages,
  loaded,
  hasMoreBefore,
  sessions,
  spectators,
  meId,
  meHandle,
  editRequestId,
  highlightId,
  onEditRequestHandled,
  onLoadEarlier,
  onOpenThread,
  onOpenSession,
  onRunDemoAgent,
  demoAgentBusy,
  onInsertAgentCommand,
  onSayHello,
  onConnectProvider,
  onRetry,
  onEdit,
  onDelete,
  onReact,
  resolveUser,
  onMarkupEntry,
  unreadDividerAfterId,
  dividerReady = true,
  onReachBottom,
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
  /** Message to scroll to and briefly highlight (search jump). */
  highlightId?: number | null;
  onEditRequestHandled?: () => void;
  onLoadEarlier: () => Promise<void>;
  onOpenThread: (rootEventId: number) => void;
  onOpenSession: (sessionId: string) => void;
  onRunDemoAgent?: () => void;
  demoAgentBusy?: boolean;
  onInsertAgentCommand?: () => void;
  onSayHello?: () => void;
  onConnectProvider?: () => void;
  onRetry: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage, text: string) => Promise<void>;
  onDelete?: (message: ChatMessage) => Promise<void>;
  onReact?: (message: ChatMessage, emoji: string) => Promise<void>;
  resolveUser?: (id: string) => UserRef | undefined;
  onMarkupEntry?: (handle: string, message: ChatMessage) => void;
  unreadDividerAfterId?: number | null;
  dividerReady?: boolean;
  onReachBottom?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const prevHeightRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string>('');
  const didInitialScrollRef = useRef(false);
  const unreadLandingScrollTopRef = useRef<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [dividerInView, setDividerInView] = useState(true);

  const items = useMemo(() => buildTimelineItems(messages), [messages]);
  const lastKey = items.at(-1)?.key ?? '';
  const firstUnreadId = useMemo(() => {
    if (unreadDividerAfterId == null || unreadDividerAfterId <= 0) return null;
    return messages.find((m) => (m.id ?? 0) > unreadDividerAfterId)?.id ?? null;
  }, [messages, unreadDividerAfterId]);
  const unreadCount = useMemo(() => {
    if (unreadDividerAfterId == null || unreadDividerAfterId <= 0) return 0;
    return messages.filter((m) => (m.id ?? 0) > unreadDividerAfterId).length;
  }, [messages, unreadDividerAfterId]);

  const updateDividerInView = useCallback(() => {
    const el = containerRef.current;
    if (!el || firstUnreadId == null) {
      setDividerInView(true);
      return;
    }
    const divider = el.querySelector<HTMLElement>(UNREAD_DIVIDER_SELECTOR);
    if (!divider) {
      setDividerInView(false);
      return;
    }
    const top = divider.offsetTop;
    setDividerInView(top >= el.scrollTop && top <= el.scrollTop + el.clientHeight);
  }, [firstUnreadId]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP_PX;
    stickRef.current = nearBottom;
    setAtBottom(nearBottom);
    if (
      nearBottom &&
      (unreadLandingScrollTopRef.current == null ||
        el.scrollTop > unreadLandingScrollTopRef.current + 4)
    ) {
      unreadLandingScrollTopRef.current = null;
      onReachBottom?.();
    }
    updateDividerInView();
  };

  // Keep pinned to bottom for new messages; preserve position when older
  // history is prepended.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!didInitialScrollRef.current) return;
    if (prevHeightRef.current == null && lastKey === lastKeyRef.current) return;
    if (prevHeightRef.current != null) {
      el.scrollTop += el.scrollHeight - prevHeightRef.current;
      prevHeightRef.current = null;
      updateDividerInView();
      return;
    }
    if (stickRef.current && lastKey !== lastKeyRef.current) {
      el.scrollTop = el.scrollHeight;
      unreadLandingScrollTopRef.current = null;
      setAtBottom(true);
      updateDividerInView();
      onReachBottom?.();
    }
    lastKeyRef.current = lastKey;
  }, [lastKey, items, onReachBottom, updateDividerInView]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || items.length === 0 || !dividerReady || didInitialScrollRef.current) return;

    if (firstUnreadId != null) {
      const divider = el.querySelector<HTMLElement>(UNREAD_DIVIDER_SELECTOR);
      divider?.scrollIntoView?.({ block: 'start' });
      setDividerInView(true);
      // Short channel: the whole unread run fits on screen, so landing on the
      // divider also leaves us at the bottom. There's nothing to scroll to, so
      // treat it as read rather than leaving it perpetually unread.
      if (el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP_PX) {
        unreadLandingScrollTopRef.current = null;
        stickRef.current = true;
        setAtBottom(true);
        onReachBottom?.();
      } else {
        unreadLandingScrollTopRef.current = el.scrollTop;
        stickRef.current = false;
        setAtBottom(false);
      }
    } else {
      el.scrollTop = el.scrollHeight;
      unreadLandingScrollTopRef.current = null;
      stickRef.current = true;
      setAtBottom(true);
      setDividerInView(true);
      onReachBottom?.();
    }

    didInitialScrollRef.current = true;
    lastKeyRef.current = lastKey;
  }, [dividerReady, firstUnreadId, items.length, lastKey, onReachBottom]);

  const loadEarlier = () => {
    if (loadingEarlier) return;
    prevHeightRef.current = containerRef.current?.scrollHeight ?? null;
    setLoadingEarlier(true);
    onLoadEarlier().finally(() => setLoadingEarlier(false));
  };

  // Search jump: center the target row and unpin from the bottom.
  useLayoutEffect(() => {
    if (highlightId == null) return;
    const el = containerRef.current?.querySelector(`[data-eid="${highlightId}"]`);
    if (el) {
      unreadLandingScrollTopRef.current = null;
      stickRef.current = false;
      setAtBottom(false);
      el.scrollIntoView?.({ block: 'center' });
      updateDividerInView();
    }
  }, [highlightId, updateDividerInView]);

  const jumpToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    unreadLandingScrollTopRef.current = null;
    stickRef.current = true;
    setAtBottom(true);
    updateDividerInView();
    onReachBottom?.();
  }, [onReachBottom, updateDividerInView]);

  const jumpToUnread = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const divider = el.querySelector<HTMLElement>(UNREAD_DIVIDER_SELECTOR);
    if (!divider) return;
    divider.scrollIntoView?.({ block: 'start' });
    unreadLandingScrollTopRef.current = el.scrollTop;
    stickRef.current = false;
    setAtBottom(false);
    setDividerInView(true);
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={onScroll}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        className="relative flex-1 overflow-y-auto pb-4 pt-2"
      >
        {hasMoreBefore && (
          <div className="flex justify-center py-2">
            <button
              type="button"
              onClick={loadEarlier}
              disabled={loadingEarlier}
              className="rounded-full border border-edge-strong bg-surface-raised px-3 py-1 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body disabled:text-fg-faint"
            >
              {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {!loaded && items.length === 0 && <TimelineSkeleton />}
        {loaded && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="w-full max-w-md rounded-lg border border-edge-strong bg-surface-raised/70 px-6 py-6 shadow-lg shadow-black/10">
              <span className="sr-only">No messages yet.</span>
              <div className="text-2xs font-semibold uppercase tracking-wider text-accent-text">
                First run
              </div>
              <h2 className="mt-2 text-lg font-semibold text-fg">See an agent work</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-fg-muted">
                Start a no-setup demo, watch the transcript stream live, then connect a provider for real tasks.
              </p>
              <div className="mt-5 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
                <button
                  type="button"
                  onClick={onRunDemoAgent}
                  disabled={!onRunDemoAgent || demoAgentBusy}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-on-accent shadow-sm transition-colors hover:bg-accent-hover disabled:cursor-default disabled:bg-surface-overlay disabled:text-fg-muted"
                >
                  {demoAgentBusy ? 'Starting demo…' : 'Run a demo agent'}
                </button>
                <button
                  type="button"
                  onClick={onInsertAgentCommand}
                  disabled={!onInsertAgentCommand}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-edge-strong bg-surface px-3 text-sm font-medium text-fg-secondary transition-colors hover:bg-surface-overlay hover:text-fg disabled:cursor-default disabled:text-fg-faint"
                >
                  Insert <code className="ml-1 rounded bg-surface-overlay/80 px-1 py-0.5 text-2xs text-accent-text">@agent</code>
                </button>
              </div>
              <div className="mt-4">
                <button
                  type="button"
                  onClick={onSayHello}
                  disabled={!onSayHello}
                  className="text-xs text-fg-tertiary hover:text-fg hover:underline disabled:no-underline"
                >
                  Say hello instead
                </button>
              </div>
              {onConnectProvider && (
                <div className="mt-5 border-t border-edge pt-4">
                  <button
                    type="button"
                    onClick={onConnectProvider}
                    className="text-xs font-medium text-fg-muted hover:text-fg-secondary hover:underline"
                  >
                    Connect a provider
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {items.map((item) => {
          const showUnreadDivider =
            item.kind === 'message' &&
            firstUnreadId != null &&
            item.message!.id === firstUnreadId;
          return item.kind === 'day' ? (
            <div key={item.key} className="my-3 flex items-center gap-3 px-4">
              <div className="h-px flex-1 bg-surface-overlay" />
              <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
                {item.label}
              </span>
              <div className="h-px flex-1 bg-surface-overlay" />
            </div>
          ) : (
            <div key={item.key}>
              {showUnreadDivider && (
                <section
                  className="my-2 flex items-center gap-3 px-4"
                  aria-label="New messages"
                  data-unread-divider
                >
                  <span className="text-3xs font-semibold uppercase tracking-wide text-accent-text">New</span>
                  <div className="h-px flex-1 bg-edge" />
                </section>
              )}
              <MessageRow
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
                highlighted={highlightId != null && item.message!.id === highlightId}
                editRequested={editRequestId != null && item.message!.id === editRequestId}
                onEditRequestHandled={onEditRequestHandled}
                onOpenThread={onOpenThread}
                onOpenSession={onOpenSession}
                onRetry={onRetry}
                onEdit={onEdit}
                onDelete={onDelete}
                onReact={onReact}
                resolveUser={resolveUser}
                onMarkupEntry={onMarkupEntry}
              />
            </div>
          );
        })}
      </div>
      {firstUnreadId != null && !dividerInView && !atBottom && (
        <button
          type="button"
          data-testid="jump-to-unread"
          aria-label={`Jump to ${unreadCount} new ${unreadCount === 1 ? 'message' : 'messages'}`}
          onClick={jumpToUnread}
          className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-on-accent shadow-lg shadow-black/15 transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {unreadCount} new
        </button>
      )}
      {!atBottom && (
        <button
          type="button"
          data-testid="jump-to-latest"
          aria-label="Jump to latest messages"
          title="Jump to latest messages"
          onClick={jumpToLatest}
          className="absolute bottom-4 right-4 z-10 inline-flex size-9 items-center justify-center rounded-full border border-edge-strong bg-surface-raised text-fg-secondary shadow-lg shadow-black/15 transition-colors hover:bg-surface-overlay hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <ChevronDownIcon size={16} aria-hidden />
        </button>
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
          <div className="size-8 shrink-0 rounded-md bg-surface-overlay/80" />
          <div className="min-w-0 flex-1">
            <div className="h-3 w-28 rounded bg-surface-overlay/80" />
            <div className="mt-1.5 h-3 rounded bg-surface-overlay/50" style={{ width: `${60 - i * 15}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
