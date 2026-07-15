import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import type { Session } from '../sessions/types';
import { buildTimelineItems, isAgentVoiceBroadcast } from '@atrium/surface-client';
import { ChevronDownIcon } from './icons';
import { MessageRow } from './MessageRow';
import type { MentionContext } from './useMentionTypeahead';

const UNREAD_DIVIDER_SELECTOR = '[data-unread-divider]';
const AT_BOTTOM_EPSILON_PX = 4;
const PINNED_BOTTOM_SLOP_PX = 80;
const SCROLL_POSITION_EPSILON_PX = 1;

export function Timeline({
  messages,
  loaded,
  hasMoreBefore,
  sessions,
  spectators,
  meId,
  meHandle,
  mentionContext,
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
  onDelegateToAgent,
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
  mentionContext?: MentionContext;
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
  onDelegateToAgent?: (message: ChatMessage) => void;
  unreadDividerAfterId?: number | null;
  dividerReady?: boolean;
  onReachBottom?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const prevHeightRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string>('');
  const didInitialScrollRef = useRef(false);
  const unreadLandingScrollTopRef = useRef<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [answerChip, setAnswerChip] = useState<{ answerId: number; rootId: number; ask: string } | null>(null);
  const [jumpFlashId, setJumpFlashId] = useState<number | null>(null);
  const previousAnswerIdRef = useRef<number | null | undefined>(undefined);
  const chipTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const { visibleMessages, answersByRoot, loadedRootIds } = useMemo(() => {
    const rootIds = new Set(
      messages
        .filter((message) => message.threadRootEventId == null && message.id != null)
        .map((message) => message.id!),
    );
    const answers = new Map<number, ChatMessage[]>();
    // Only AGENT-VOICE broadcast replies (session answers/questions) anchor
    // under their loaded root — the cluster's slot presentation carries the
    // agent identity. A human "also send to channel" reply stays in the feed
    // as its own row, attributed to its author; rendering one message twice
    // (cluster preview + standalone row) is still the failure mode, so the
    // cluster suppresses its compact preview for broadcast replies.
    for (const message of messages) {
      if (
        isAgentVoiceBroadcast(message) &&
        message.sessionEventType !== 'question_requested' &&
        message.threadRootEventId != null &&
        rootIds.has(message.threadRootEventId)
      ) {
        const current = answers.get(message.threadRootEventId) ?? [];
        current.push(message);
        answers.set(message.threadRootEventId, current);
      }
    }
    const isAnchoredAnnotationEvent = (message: ChatMessage) =>
      isAgentVoiceBroadcast(message) && message.threadRootEventId != null && rootIds.has(message.threadRootEventId);
    return {
      visibleMessages: messages.filter((message) => !isAnchoredAnnotationEvent(message)),
      answersByRoot: answers,
      loadedRootIds: rootIds,
    };
  }, [messages]);
  const sessionsByRoot = useMemo(() => {
    const byRoot = new Map<number, Session[]>();
    for (const session of Object.values(sessions)) {
      if (session.threadRootEventId == null) continue;
      const current = byRoot.get(session.threadRootEventId) ?? [];
      current.push(session);
      byRoot.set(session.threadRootEventId, current);
    }
    for (const current of byRoot.values()) {
      current.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    return byRoot;
  }, [sessions]);
  const items = useMemo(() => buildTimelineItems(visibleMessages), [visibleMessages]);
  const lastKey = items.at(-1)?.key ?? '';
  const lastMessageId = visibleMessages.at(-1)?.id ?? null;
  const firstUnreadId = useMemo(() => {
    if (unreadDividerAfterId == null || unreadDividerAfterId <= 0) return null;
    const anchoredUnread = messages.find(
      (message) =>
        (message.id ?? 0) > unreadDividerAfterId &&
        (message.sessionEventType === 'replied' ||
          message.sessionEventType === 'question_requested' ||
          (message.sessionId != null && message.sessionTask != null)) &&
        message.threadRootEventId != null &&
        loadedRootIds.has(message.threadRootEventId),
    );
    if (anchoredUnread?.threadRootEventId != null) return anchoredUnread.threadRootEventId;
    return visibleMessages.find((message) => (message.id ?? 0) > unreadDividerAfterId)?.id ?? null;
  }, [loadedRootIds, messages, unreadDividerAfterId, visibleMessages]);
  const unreadCount = useMemo(() => {
    if (unreadDividerAfterId == null || unreadDividerAfterId <= 0) return 0;
    return messages.filter((m) => (m.id ?? 0) > unreadDividerAfterId).length;
  }, [messages, unreadDividerAfterId]);

  const isAtBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_EPSILON_PX;
  }, []);

  const isPinnedToBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_BOTTOM_SLOP_PX;
  }, []);

  const isNewestMessageVisible = useCallback(() => {
    const el = containerRef.current;
    if (!el || lastMessageId == null) return false;
    const latest = el.querySelector<HTMLElement>(`[data-eid="${lastMessageId}"]`);
    if (!latest) return false;
    const latestRect = latest.getBoundingClientRect();
    const containerRect = el.getBoundingClientRect();
    return latestRect.bottom >= containerRect.top && latestRect.top <= containerRect.bottom;
  }, [lastMessageId]);

  const isRootVisible = useCallback((rootId: number) => {
    const container = containerRef.current;
    const row = container?.querySelector<HTMLElement>(`[data-eid="${rootId}"]`);
    if (!container || !row) return false;
    const rowRect = row.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return rowRect.bottom >= containerRect.top && rowRect.top <= containerRect.bottom;
  }, []);

  useEffect(() => {
    const latest = messages
      .filter(
        (message) =>
          message.id != null &&
          message.broadcast === true &&
          message.sessionEventType === 'replied' &&
          message.threadRootEventId != null &&
          answersByRoot.has(message.threadRootEventId),
      )
      .at(-1);
    const latestId = latest?.id ?? null;
    if (previousAnswerIdRef.current === undefined) {
      previousAnswerIdRef.current = latestId;
      return;
    }
    if (!latest || latest.id === previousAnswerIdRef.current || latest.threadRootEventId == null) return;
    previousAnswerIdRef.current = latest.id;
    if (isRootVisible(latest.threadRootEventId)) return;
    const root = messages.find((message) => message.id === latest.threadRootEventId);
    const ask = (root?.sessionTask ?? root?.text ?? '').trim().slice(0, 40);
    setAnswerChip({ answerId: latest.id!, rootId: latest.threadRootEventId, ask });
    if (chipTimerRef.current) window.clearTimeout(chipTimerRef.current);
    chipTimerRef.current = window.setTimeout(() => setAnswerChip(null), 10_000);
  }, [answersByRoot, isRootVisible, messages]);

  useEffect(
    () => () => {
      if (chipTimerRef.current) window.clearTimeout(chipTimerRef.current);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const markReadIfNewestVisible = useCallback(() => {
    if (!isNewestMessageVisible()) return;
    unreadLandingScrollTopRef.current = null;
    onReachBottom?.();
  }, [isNewestMessageVisible, onReachBottom]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const bottom = isAtBottom(el);
    stickRef.current = isPinnedToBottom(el);
    if (
      unreadLandingScrollTopRef.current != null &&
      Math.abs(el.scrollTop - unreadLandingScrollTopRef.current) > SCROLL_POSITION_EPSILON_PX
    ) {
      unreadLandingScrollTopRef.current = null;
    }
    setAtBottom(bottom);
    if (answerChip && isRootVisible(answerChip.rootId)) setAnswerChip(null);
    markReadIfNewestVisible();
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
      return;
    }
    if (stickRef.current && lastKey !== lastKeyRef.current) {
      el.scrollTop = el.scrollHeight;
      unreadLandingScrollTopRef.current = null;
      setAtBottom(true);
      markReadIfNewestVisible();
    }
    lastKeyRef.current = lastKey;
  }, [lastKey, items, markReadIfNewestVisible]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || items.length === 0 || !dividerReady || didInitialScrollRef.current) return;

    if (firstUnreadId != null) {
      const divider = el.querySelector<HTMLElement>(UNREAD_DIVIDER_SELECTOR);
      divider?.scrollIntoView?.({ block: 'start' });
      if (isNewestMessageVisible()) {
        unreadLandingScrollTopRef.current = null;
        stickRef.current = isPinnedToBottom(el);
        setAtBottom(isAtBottom(el));
        markReadIfNewestVisible();
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
      markReadIfNewestVisible();
    }

    didInitialScrollRef.current = true;
    lastKeyRef.current = lastKey;
  }, [
    dividerReady,
    firstUnreadId,
    isAtBottom,
    isNewestMessageVisible,
    isPinnedToBottom,
    items.length,
    lastKey,
    markReadIfNewestVisible,
  ]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (!didInitialScrollRef.current) return;

      const unreadLandingScrollTop = unreadLandingScrollTopRef.current;
      if (unreadLandingScrollTop != null) {
        if (Math.abs(el.scrollTop - unreadLandingScrollTop) > SCROLL_POSITION_EPSILON_PX) {
          unreadLandingScrollTopRef.current = null;
          return;
        }

        const divider = el.querySelector<HTMLElement>(UNREAD_DIVIDER_SELECTOR);
        if (!divider) {
          unreadLandingScrollTopRef.current = null;
          return;
        }

        divider.scrollIntoView?.({ block: 'start' });
        if (isNewestMessageVisible()) {
          unreadLandingScrollTopRef.current = null;
          stickRef.current = isPinnedToBottom(el);
          setAtBottom(isAtBottom(el));
          markReadIfNewestVisible();
        } else {
          unreadLandingScrollTopRef.current = el.scrollTop;
          stickRef.current = false;
          setAtBottom(false);
        }
        return;
      }

      if (!stickRef.current) return;
      el.scrollTop = el.scrollHeight;
      setAtBottom(true);
      markReadIfNewestVisible();
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [isAtBottom, isNewestMessageVisible, isPinnedToBottom, markReadIfNewestVisible]);

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
    }
  }, [highlightId]);

  const jumpToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    unreadLandingScrollTopRef.current = null;
    stickRef.current = true;
    setAtBottom(true);
    markReadIfNewestVisible();
  }, [markReadIfNewestVisible]);

  const jumpToUnread = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const divider = el.querySelector<HTMLElement>(UNREAD_DIVIDER_SELECTOR);
    if (!divider) return;
    divider.scrollIntoView?.({ block: 'start' });
    unreadLandingScrollTopRef.current = el.scrollTop;
    stickRef.current = false;
    setAtBottom(false);
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={onScroll}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        className="relative flex-1 overflow-x-clip overflow-y-auto pb-4 pt-2"
      >
        <div ref={contentRef} className="min-h-full">
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
                <div className="text-2xs font-semibold uppercase tracking-wider text-accent-text">First run</div>
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
                    Insert{' '}
                    <code className="ml-1 rounded bg-surface-overlay/80 px-1 py-0.5 text-2xs text-accent-text">!!</code>
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
          {items.map((item, index) => {
            const showUnreadDivider =
              item.kind === 'message' && firstUnreadId != null && item.message!.id === firstUnreadId;
            // A row never author-groups across a cluster: when the previous row
            // carries a slot/cluster (replies, anchored answers, or sessions),
            // the grouped header suppression would strand this row's authorship
            // below someone else's annotation block.
            const previous = index > 0 ? items[index - 1] : undefined;
            const previousMessage = previous?.kind === 'message' ? previous.message : undefined;
            const previousHasCluster =
              previousMessage?.id != null &&
              (previousMessage.replyCount > 0 ||
                answersByRoot.has(previousMessage.id) ||
                sessionsByRoot.has(previousMessage.id));
            const rowMessage = item.message;
            const rowSessions =
              item.kind === 'message' && rowMessage?.id != null ? [...(sessionsByRoot.get(rowMessage.id) ?? [])] : [];
            if (
              rowMessage?.sessionId != null &&
              sessions[rowMessage.sessionId] &&
              !rowSessions.some((session) => session.id === rowMessage.sessionId)
            ) {
              rowSessions.push(sessions[rowMessage.sessionId]!);
            }
            return item.kind === 'day' ? (
              <div key={item.key} className="my-3 flex items-center gap-3 px-4">
                <div className="h-px flex-1 bg-surface-overlay" />
                <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">{item.label}</span>
                <div className="h-px flex-1 bg-surface-overlay" />
              </div>
            ) : (
              <div key={item.key}>
                {showUnreadDivider && (
                  <section className="my-3 flex items-center gap-3 px-4" aria-label="New messages" data-unread-divider>
                    <div className="h-px flex-1 bg-accent-border-muted/70" />
                    <span className="rounded-full border border-accent-border-muted/60 bg-accent-tint/30 px-2.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-accent-text-strong">
                      New messages
                    </span>
                    <div className="h-px flex-1 bg-accent-border-muted/70" />
                  </section>
                )}
                <MessageRow
                  message={item.message!}
                  grouped={(item.grouped ?? false) && !previousHasCluster}
                  slotSessions={rowSessions}
                  anchoredAnswers={item.message!.id != null ? (answersByRoot.get(item.message!.id) ?? []) : []}
                  session={
                    item.message!.sessionId != null
                      ? sessions[item.message!.sessionId]
                      : item.message!.suggestedSessionId
                        ? sessions[item.message!.suggestedSessionId]
                        : item.message!.steeredSessionId
                          ? sessions[item.message!.steeredSessionId]
                          : undefined
                  }
                  spectators={item.message!.sessionId != null ? (spectators[item.message!.sessionId] ?? 0) : 0}
                  meId={meId}
                  meHandle={meHandle}
                  mentionContext={mentionContext}
                  highlighted={
                    (highlightId != null && item.message!.id === highlightId) ||
                    (jumpFlashId != null && item.message!.id === jumpFlashId)
                  }
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
                  onDelegateToAgent={onDelegateToAgent}
                />
              </div>
            );
          })}
        </div>
      </div>
      {answerChip && (
        <button
          type="button"
          data-testid="agent-answer-jump-chip"
          onClick={() => {
            const row = containerRef.current?.querySelector<HTMLElement>(`[data-eid="${answerChip.rootId}"]`);
            row?.scrollIntoView?.({ block: 'center' });
            stickRef.current = false;
            setAtBottom(false);
            setJumpFlashId(answerChip.rootId);
            setAnswerChip(null);
            if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
            flashTimerRef.current = window.setTimeout(() => setJumpFlashId(null), 1800);
          }}
          className="absolute bottom-16 left-1/2 z-raised max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-full bg-accent px-4 py-2 text-xs font-semibold text-on-accent shadow-lg shadow-black/20"
        >
          ↑ Agent answered — “{answerChip.ask}”
        </button>
      )}
      {!atBottom && (
        <div className="absolute bottom-4 right-4 z-raised inline-flex max-w-[calc(100%-2rem)] overflow-hidden rounded-full border border-edge-strong bg-surface-raised text-xs font-semibold text-fg-secondary shadow-lg shadow-black/15">
          {firstUnreadId != null && unreadCount > 0 && (
            <button
              type="button"
              data-testid="jump-to-unread"
              aria-label={`Jump to ${unreadCount} new ${unreadCount === 1 ? 'message' : 'messages'}`}
              onClick={jumpToUnread}
              className="inline-flex h-9 items-center whitespace-nowrap border-r border-edge px-3 text-accent-text-strong transition-colors hover:bg-accent-tint/35 focus-visible:z-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              {unreadCount} new
            </button>
          )}
          <button
            type="button"
            data-testid="jump-to-latest"
            aria-label={
              unreadCount > 0
                ? `Jump to latest messages, ${unreadCount} new ${unreadCount === 1 ? 'message' : 'messages'}`
                : 'Jump to latest messages'
            }
            title="Jump to latest messages"
            onClick={jumpToLatest}
            className="inline-flex h-9 min-w-0 items-center gap-1.5 whitespace-nowrap px-3 transition-colors hover:bg-surface-overlay hover:text-fg focus-visible:z-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <ChevronDownIcon size={15} aria-hidden className="shrink-0" />
            <span className="truncate">Jump to latest</span>
          </button>
        </div>
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
