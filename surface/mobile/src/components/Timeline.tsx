// Channel/thread message list: FlashList v2, inverted (newest at the bottom),
// older pages load as you scroll up.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import {
  buildTimelineItems,
  type ChatMessage,
  type Session,
  type TimelineItem,
} from '@atrium/surface-client';
import { colors, font, space } from '../lib/theme';
import { DayDivider } from './bits';
import { MessageRow } from './MessageRow';

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
  onLoadEarlier: () => Promise<void>;
  onLongPress: (m: ChatMessage) => void;
  onOpenThread?: (m: ChatMessage) => void;
  onToggleReaction: (m: ChatMessage, emoji: string) => void;
  onRetry: (m: ChatMessage) => void;
  onOpenAttachment: (fileId: string) => void;
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
  onLoadEarlier,
  onLongPress,
  onOpenThread,
  onToggleReaction,
  onRetry,
  onOpenAttachment,
}: TimelineProps) {
  const listRef = useRef<FlashListRef<TimelineItem>>(null);

  // Chronological (oldest-first); FlashList v2 anchors rendering at the bottom.
  const items = useMemo(() => buildTimelineItems(messages), [messages]);

  // Jump-to-message (search): scroll the highlighted row into view.
  useEffect(() => {
    if (highlightId == null) return;
    const index = items.findIndex((it) => it.message?.id === highlightId);
    if (index < 0) return;
    try {
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    } catch {
      /* row recycled away — highlight still shows when reached manually */
    }
  }, [highlightId, items]);

  const loadingOlder = useRef(false);
  const handleStartReached = useCallback(() => {
    if (!hasMoreBefore || loadingOlder.current) return;
    loadingOlder.current = true;
    onLoadEarlier().finally(() => {
      loadingOlder.current = false;
    });
  }, [hasMoreBefore, onLoadEarlier]);

  const renderItem = useCallback(
    ({ item }: { item: TimelineItem }) => {
      if (item.kind === 'day') return <DayDivider label={item.label} />;
      const m = item.message!;
      return (
        <MessageRow
          message={m}
          grouped={item.grouped === true}
          meId={meId}
          meHandle={meHandle}
          highlighted={highlightId != null && m.id === highlightId}
          session={m.sessionId ? sessions[m.sessionId] : undefined}
          inThread={inThread}
          fileUrl={fileUrl}
          onLongPress={onLongPress}
          onOpenThread={onOpenThread}
          onToggleReaction={onToggleReaction}
          onRetry={onRetry}
          onOpenAttachment={onOpenAttachment}
        />
      );
    },
    [
      meId,
      meHandle,
      highlightId,
      sessions,
      inThread,
      fileUrl,
      onLongPress,
      onOpenThread,
      onToggleReaction,
      onRetry,
      onOpenAttachment,
    ],
  );

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
  );
}
