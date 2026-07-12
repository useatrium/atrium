// Channel/thread message list: FlashList v2, chronological and not inverted,
// older pages load as you scroll up.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FlashList, type FlashListRef, type ViewToken } from '@shopify/flash-list';
import {
  buildTimelineItems,
  type Api,
  type ChatMessage,
  type Session,
  type TimelineItem,
  type UserRef,
} from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../lib/theme';
import { useReactionUserResolver } from '../lib/chat';
import { DayDivider } from './bits';
import { MessageRow } from './MessageRow';
import type { ArtifactContentResolver, EntryResolver } from '../lib/entryResolve';

export interface TimelineProps {
  messages: ChatMessage[];
  loaded: boolean;
  hasMoreBefore: boolean;
  sessions: Record<string, Session>;
  meId: string;
  meHandle: string | null;
  highlightId: number | null;
  inThread?: boolean;
  emptyLabel?: string;
  fileUrl: (id: string) => string;
  api: Api;
  serverUrl: string;
  resolveEntry: EntryResolver;
  resolveArtifactContent?: ArtifactContentResolver;
  resolveUser?: (id: string) => UserRef | undefined;
  fileHeaders?: Record<string, string>;
  onLoadEarlier: () => Promise<void>;
  onLongPress: (m: ChatMessage) => void;
  onOpenThread?: (m: ChatMessage) => void;
  onToggleReaction: (m: ChatMessage, emoji: string) => void;
  onRetry: (m: ChatMessage) => void;
  onOpenAttachment: (message: ChatMessage, index: number) => void;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onAnswerSessionQuestion?: (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ) => Promise<void>;
  onSuggestSessionAnswer?: (sessionId: string, text: string) => Promise<void>;
  unreadDividerAfterId?: number | null;
  dividerReady?: boolean;
  onReachBottom?: () => void;
}

export interface UnreadDividerPlacement {
  firstUnreadId: number | null;
  firstUnreadIndex: number | null;
  unreadCount: number;
}

export function getUnreadDividerPlacement(
  items: TimelineItem[],
  unreadDividerAfterId?: number | null,
): UnreadDividerPlacement {
  if (unreadDividerAfterId == null || unreadDividerAfterId <= 0) {
    return { firstUnreadId: null, firstUnreadIndex: null, unreadCount: 0 };
  }

  let firstUnreadId: number | null = null;
  let firstUnreadIndex: number | null = null;
  let unreadCount = 0;

  items.forEach((item, index) => {
    if (item.kind !== 'message') return;
    const id = item.message?.id ?? 0;
    if (id <= unreadDividerAfterId) return;
    unreadCount += 1;
    if (firstUnreadId == null) {
      firstUnreadId = id;
      firstUnreadIndex = index;
    }
  });

  return { firstUnreadId, firstUnreadIndex, unreadCount };
}

function lastRenderedMessageKey(items: TimelineItem[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === 'message') return item.key;
  }
  return '';
}

export function latestRealMessageId(items: TimelineItem[]): number | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === 'message') return item.message?.id ?? null;
  }
  return null;
}

export function shouldMarkReadForVisibleLatest(
  viewableItems: Array<Pick<ViewToken<TimelineItem>, 'isViewable' | 'item'>>,
  latestMessageId: number | null,
  userDragged: boolean,
): boolean {
  if (!userDragged || latestMessageId == null) return false;
  return viewableItems.some(
    (token) => token.isViewable && token.item.kind === 'message' && token.item.message?.id === latestMessageId,
  );
}

function UnreadDivider() {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="New messages"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: colors.accent }} />
      <Text
        style={{
          color: colors.accent,
          fontSize: font.xs,
          fontWeight: '800',
          textTransform: 'uppercase',
        }}
      >
        New messages
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.accent }} />
    </View>
  );
}

export function Timeline({
  messages,
  loaded,
  hasMoreBefore,
  sessions,
  meId,
  meHandle,
  highlightId,
  inThread,
  emptyLabel,
  fileUrl,
  api,
  serverUrl,
  resolveEntry,
  resolveArtifactContent,
  resolveUser,
  fileHeaders,
  onLoadEarlier,
  onLongPress,
  onOpenThread,
  onToggleReaction,
  onRetry,
  onOpenAttachment,
  onOpenChannel,
  onOpenSession,
  onAnswerSessionQuestion,
  onSuggestSessionAnswer,
  unreadDividerAfterId,
  dividerReady,
  onReachBottom,
}: TimelineProps) {
  const { colors, reduceMotion } = useTheme();
  const listRef = useRef<FlashListRef<TimelineItem>>(null);
  const resolvedReactionUser = useReactionUserResolver(messages);
  const reactionUserResolver = resolveUser ?? resolvedReactionUser;

  // Chronological (oldest-first); FlashList v2 anchors rendering at the bottom.
  const items = useMemo(() => buildTimelineItems(messages), [messages]);
  const { firstUnreadId, firstUnreadIndex, unreadCount } = useMemo(
    () => getUnreadDividerPlacement(items, unreadDividerAfterId),
    [items, unreadDividerAfterId],
  );
  const latestRenderedMessageKey = useMemo(() => lastRenderedMessageKey(items), [items]);
  const latestMessageId = useMemo(() => latestRealMessageId(items), [items]);
  const readyForDivider = dividerReady ?? true;
  const [atBottom, setAtBottom] = useState(firstUnreadId == null);
  const atBottomRef = useRef(firstUnreadId == null);
  const initialPositionedRef = useRef(false);
  const latestRenderedMessageKeyRef = useRef(latestRenderedMessageKey);
  const latestMessageIdRef = useRef(latestMessageId);
  const viewabilityConfigRef = useRef({ itemVisiblePercentThreshold: 10 });
  // FlashList renders anchored at the bottom (startRenderingFromBottom) and the
  // initial scroll-to-divider is programmatic, so a scroll reaching the bottom
  // only counts as "read" once the user has actually dragged the list. Without
  // this, opening an unread channel marks it read before landing on the divider.
  const userDraggedRef = useRef(false);

  const setAtBottomValue = useCallback((next: boolean) => {
    if (atBottomRef.current === next) return;
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);

  const startScrollToIndexRetry = useCallback((index: number, viewPosition: number, animated: boolean) => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scroll = (attempt: number) => {
      if (cancelled) return;
      try {
        void listRef.current?.scrollToIndex({ index, animated, viewPosition })?.catch(() => {
          /* row may not be measured yet; bounded retry below */
        });
      } catch {
        /* row may not be measured yet; bounded retry below */
      }
      if (attempt < 3) timer = setTimeout(() => scroll(attempt + 1), 250);
    };
    scroll(1);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    latestMessageIdRef.current = latestMessageId;
  }, [latestMessageId]);

  // Jump-to-message (search): scroll the highlighted row into view.
  useEffect(() => {
    if (highlightId == null) return;
    const index = items.findIndex((it) => it.message?.id === highlightId);
    if (index < 0) return;
    setAtBottomValue(false);
    return startScrollToIndexRetry(index, 0.5, !reduceMotion);
  }, [highlightId, items, reduceMotion, setAtBottomValue, startScrollToIndexRetry]);

  // Initial channel entry: unread channels land at the divider; all-read
  // channels keep FlashList's bottom anchor and advance the cursor there.
  useEffect(() => {
    if (initialPositionedRef.current || !loaded || !readyForDivider) return;
    initialPositionedRef.current = true;
    if (firstUnreadId != null && firstUnreadIndex != null) {
      setAtBottomValue(false);
      return startScrollToIndexRetry(firstUnreadIndex, 0, false);
    }
    setAtBottomValue(true);
    onReachBottom?.();
    return undefined;
  }, [
    firstUnreadId,
    firstUnreadIndex,
    loaded,
    onReachBottom,
    readyForDivider,
    setAtBottomValue,
    startScrollToIndexRetry,
  ]);

  // FlashList keeps new messages pinned when already near the bottom; mirror
  // that by advancing the read cursor when the rendered tail changes there.
  useEffect(() => {
    if (!loaded || !readyForDivider) return;
    if (latestRenderedMessageKey === latestRenderedMessageKeyRef.current) return;
    latestRenderedMessageKeyRef.current = latestRenderedMessageKey;
    if (atBottomRef.current) onReachBottom?.();
  }, [latestRenderedMessageKey, loaded, onReachBottom, readyForDivider]);

  const loadingOlder = useRef(false);
  const handleStartReached = useCallback(() => {
    if (!hasMoreBefore || loadingOlder.current) return;
    loadingOlder.current = true;
    onLoadEarlier().finally(() => {
      loadingOlder.current = false;
    });
  }, [hasMoreBefore, onLoadEarlier]);

  const handleScrollBeginDrag = useCallback(() => {
    userDraggedRef.current = true;
  }, []);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const nearBottom = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
      setAtBottomValue(nearBottom);
      // Only a user-driven scroll to the bottom advances the read cursor; the
      // initial bottom-anchored render + programmatic divider scroll must not.
      if (nearBottom && userDraggedRef.current) onReachBottom?.();
    },
    [onReachBottom, setAtBottomValue],
  );

  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<TimelineItem>[] }) => {
      if (shouldMarkReadForVisibleLatest(viewableItems, latestMessageIdRef.current, userDraggedRef.current)) {
        setAtBottomValue(true);
        onReachBottom?.();
      }
    },
    [onReachBottom, setAtBottomValue],
  );

  const scrollToUnreadDivider = useCallback(() => {
    if (firstUnreadIndex == null) return;
    setAtBottomValue(false);
    startScrollToIndexRetry(firstUnreadIndex, 0, !reduceMotion);
  }, [firstUnreadIndex, reduceMotion, setAtBottomValue, startScrollToIndexRetry]);

  const jumpToLatest = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: !reduceMotion });
    setAtBottomValue(true);
    onReachBottom?.();
  }, [onReachBottom, reduceMotion, setAtBottomValue]);

  const renderItem = useCallback(
    ({ item }: { item: TimelineItem }) => {
      if (item.kind === 'day') return <DayDivider label={item.label} />;
      const m = item.message!;
      const showUnreadDivider = firstUnreadId != null && m.id === firstUnreadId;
      const row = (
        <MessageRow
          message={m}
          grouped={item.grouped === true}
          meId={meId}
          meHandle={meHandle}
          highlighted={highlightId != null && m.id === highlightId}
          session={m.sessionId ? sessions[m.sessionId] : undefined}
          inThread={inThread}
          fileUrl={fileUrl}
          api={api}
          serverUrl={serverUrl}
          resolveEntry={resolveEntry}
          resolveArtifactContent={resolveArtifactContent}
          resolveUser={reactionUserResolver}
          fileHeaders={fileHeaders}
          onLongPress={onLongPress}
          onOpenThread={onOpenThread}
          onToggleReaction={onToggleReaction}
          onRetry={onRetry}
          onOpenAttachment={onOpenAttachment}
          onOpenChannel={onOpenChannel}
          onOpenSession={onOpenSession}
          onAnswerSessionQuestion={onAnswerSessionQuestion}
          onSuggestSessionAnswer={onSuggestSessionAnswer}
        />
      );
      if (!showUnreadDivider) return row;
      return (
        <View>
          <UnreadDivider />
          {row}
        </View>
      );
    },
    [
      firstUnreadId,
      meId,
      meHandle,
      highlightId,
      sessions,
      inThread,
      fileUrl,
      api,
      serverUrl,
      resolveEntry,
      resolveArtifactContent,
      reactionUserResolver,
      fileHeaders,
      onLongPress,
      onOpenThread,
      onToggleReaction,
      onRetry,
      onOpenAttachment,
      onOpenChannel,
      onOpenSession,
      onAnswerSessionQuestion,
      onSuggestSessionAnswer,
    ],
  );

  const jumpControlLabel = unreadCount > 0 ? `Jump to latest · ${unreadCount} new` : 'Jump to latest';
  const jumpControlAccessibilityLabel =
    unreadCount > 0 ? `Jump to latest messages, ${unreadCount} new` : 'Jump to latest messages';

  if (!loaded) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
        <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
          {emptyLabel ?? 'No messages yet — say hello.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FlashList
        ref={listRef}
        data={items}
        renderItem={renderItem}
        keyExtractor={(it) => it.key}
        maintainVisibleContentPosition={{
          startRenderingFromBottom: true,
          // Stay pinned to the latest message unless the user scrolled away.
          autoscrollToBottomThreshold: 0.2,
        }}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        scrollEventThrottle={16}
        onViewableItemsChanged={handleViewableItemsChanged}
        viewabilityConfig={viewabilityConfigRef.current}
        onStartReached={handleStartReached}
        onStartReachedThreshold={0.4}
        contentContainerStyle={{ paddingVertical: space.sm }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          hasMoreBefore ? (
            <View style={{ paddingVertical: space.md }}>
              <ActivityIndicator size="small" color={colors.textFaint} />
            </View>
          ) : null
        }
      />
      {!atBottom ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={jumpControlAccessibilityLabel}
          accessibilityHint={
            unreadCount > 0 ? 'Jumps to the latest message. Use actions to jump to new messages.' : undefined
          }
          accessibilityActions={unreadCount > 0 ? [{ name: 'jumpToUnread', label: 'Jump to new messages' }] : undefined}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'jumpToUnread') scrollToUnreadDivider();
          }}
          onPress={jumpToLatest}
          hitSlop={8}
          style={({ pressed }) => ({
            position: 'absolute',
            right: space.lg,
            bottom: space.lg,
            minHeight: 44,
            maxWidth: 260,
            paddingHorizontal: space.md,
            borderRadius: radius.lg,
            flexDirection: 'row',
            gap: space.xs,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.bgElevated,
            borderWidth: 1,
            borderColor: unreadCount > 0 ? colors.accent : colors.border,
            opacity: pressed ? 0.82 : 1,
            shadowColor: '#000',
            shadowOpacity: 0.2,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 5 },
            elevation: 5,
          })}
        >
          <Ionicons name="arrow-down" size={18} color={unreadCount > 0 ? colors.accent : colors.text} />
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{
              color: unreadCount > 0 ? colors.accent : colors.text,
              fontSize: font.sm,
              fontWeight: '800',
            }}
          >
            {jumpControlLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
