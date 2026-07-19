import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { router } from 'expo-router';
import { Swipeable } from 'react-native-gesture-handler';
import {
  activityKindMarker,
  type ActivityCounts,
  type ActivityFeedFilter,
  type ActivityItem,
  decodeWireToDisplay,
  plainMarkdownSnippet,
  formatExactTimestamp,
  formatRelativeTimestamp,
  isActivityUnread,
  matchesActivityFilter,
} from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { font, radius, space, useTheme } from '../../../src/lib/theme';
import { ConnectionBanner } from '../../../src/components/bits';
import { MobileHeader } from '../../../src/components/MobileHeader';
import { navigationTargetSize } from '../../../src/components/PlatformTabBar';

type ActivityRow =
  | { rowType: 'header'; key: string; label: string }
  | { rowType: 'filter'; key: string }
  | { rowType: 'activity'; activity: ActivityItem };

const FILTERS: Array<{ id: ActivityFeedFilter; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'unread', label: 'Unread' },
  { id: 'all', label: 'All' },
];

const PEOPLE_ACTIVITY_KINDS = new Set<ActivityItem['kind']>([
  'mention',
  'dm',
  'thread_reply',
  'reaction',
  'channel_invite',
  'missed_call',
  'call_declined',
]);

export function isPeopleActivity(item: ActivityItem): boolean {
  return PEOPLE_ACTIVITY_KINDS.has(item.kind);
}

// DM/GDM channel names are internal keys (`dm:<ids>` / `gdm:<ids>`), so the key
// prefix is the only signal that a "dm" item came from a group conversation.
function isGroupDm(item: ActivityItem): boolean {
  return item.kind === 'dm' && item.channelName.startsWith('gdm:');
}

// Calls only happen in DMs/GDMs, whose channel names are internal keys — the
// row title already names the caller, so these kinds never show a channel tag.
function hideChannelLabel(item: ActivityItem): boolean {
  return item.kind === 'dm' || item.kind === 'missed_call' || item.kind === 'call_declined';
}

export function activityItemTitle(item: ActivityItem): string {
  if (item.kind === 'mention') return `${item.actorName ?? 'Someone'} mentioned you`;
  if (item.kind === 'dm') {
    return isGroupDm(item)
      ? `${item.actorName ?? 'Someone'} messaged the group`
      : `${item.actorName ?? 'Someone'} sent a DM`;
  }
  if (item.kind === 'thread_reply') return `${item.actorName ?? 'Someone'} replied in a thread`;
  if (item.kind === 'reaction') return `${item.actorName ?? 'Someone'} reacted to your message`;
  if (item.kind === 'channel_invite') return `${item.actorName ?? 'Someone'} added you`;
  if (item.kind === 'missed_call') return `${item.actorName ?? 'Someone'} called you`;
  if (item.kind === 'call_declined') return `${item.actorName ?? 'Someone'} called · you declined`;
  return 'Activity';
}

/** @deprecated Prefer activityKindMarker from @atrium/surface-client */
export function activityItemMarker(item: ActivityItem): string {
  return activityKindMarker(item.kind);
}

function parseEventId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export default function ActivityScreen() {
  const { api, state, resolveUser, serverUrl, signInAgain } = useChat();
  const { colors } = useTheme();
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [nextActivityCursor, setNextActivityCursor] = useState<string | null>(null);
  const [lastReadEventId, setLastReadEventId] = useState('0');
  const [unreadExceptionIds, setUnreadExceptionIds] = useState<string[]>([]);
  const [counts, setCounts] = useState<ActivityCounts>({
    attention: 0,
    unread: 0,
  });
  const [filter, setFilter] = useState<ActivityFeedFilter>('inbox');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exceptionSet = useMemo(() => new Set(unreadExceptionIds), [unreadExceptionIds]);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'refresh') => {
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const activityRes = await api.getActivity();
        setActivityItems(activityRes.items.filter(isPeopleActivity));
        setNextActivityCursor(activityRes.nextCursor);
        // Decode-with-default: a deploy-skewed server may predate read-state.
        setLastReadEventId(typeof activityRes.lastReadEventId === 'string' ? activityRes.lastReadEventId : '0');
        setUnreadExceptionIds(
          Array.isArray(activityRes.unreadExceptionIds) ? activityRes.unreadExceptionIds.map(String) : [],
        );
        setCounts({
          attention: Number(activityRes.counts?.attention) || 0,
          unread: Number(activityRes.counts?.unread) || 0,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load activity');
      } finally {
        if (mode === 'initial') setLoading(false);
        else setRefreshing(false);
      }
    },
    [api],
  );

  const loadMoreActivity = useCallback(async () => {
    if (!nextActivityCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await api.getActivity(nextActivityCursor);
      setActivityItems((prev) => [...prev, ...res.items.filter(isPeopleActivity)]);
      setNextActivityCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load activity');
    } finally {
      setLoadingMore(false);
    }
  }, [api, loadingMore, nextActivityCursor]);

  useEffect(() => {
    void load('initial');
  }, [load]);

  const applyReadState = useCallback((state: { lastReadEventId: string; unreadExceptionIds?: string[] }) => {
    setLastReadEventId(state.lastReadEventId);
    if (Array.isArray(state.unreadExceptionIds)) {
      setUnreadExceptionIds(state.unreadExceptionIds.map(String));
    }
  }, []);

  const markItemRead = useCallback(
    async (item: ActivityItem) => {
      const eventId = parseEventId(item.eventId);
      if (eventId == null) return;
      const previous = { lastReadEventId, unreadExceptionIds, counts, items: activityItems };
      setLastReadEventId((w) => (Number(w) < eventId ? String(eventId) : w));
      setUnreadExceptionIds((ids) => ids.filter((id) => id !== item.eventId));
      setCounts((prev) => ({ ...prev, unread: Math.max(0, prev.unread - 1) }));
      setActivityItems((rows) => rows.map((row) => (row.eventId === item.eventId ? { ...row, unread: false } : row)));
      try {
        const response = await api.markActivityItemRead(eventId);
        applyReadState(response);
        void load();
      } catch (err) {
        setLastReadEventId(previous.lastReadEventId);
        setUnreadExceptionIds(previous.unreadExceptionIds);
        setCounts(previous.counts);
        setActivityItems(previous.items);
        setError(err instanceof Error ? err.message : 'Unable to mark activity read');
      }
    },
    [activityItems, api, applyReadState, counts, lastReadEventId, load, unreadExceptionIds],
  );

  const markItemUnread = useCallback(
    async (item: ActivityItem) => {
      const eventId = parseEventId(item.eventId);
      if (eventId == null) return;
      const previous = { lastReadEventId, unreadExceptionIds, counts, items: activityItems };
      if (!unreadExceptionIds.includes(item.eventId) && Number(item.eventId) <= Number(lastReadEventId)) {
        setUnreadExceptionIds((ids) => [...ids, item.eventId]);
      }
      setCounts((prev) => ({ ...prev, unread: Math.min(99, prev.unread + 1) }));
      setActivityItems((rows) => rows.map((row) => (row.eventId === item.eventId ? { ...row, unread: true } : row)));
      try {
        const response = await api.markActivityItemUnread(eventId);
        applyReadState(response);
        void load();
      } catch (err) {
        setLastReadEventId(previous.lastReadEventId);
        setUnreadExceptionIds(previous.unreadExceptionIds);
        setCounts(previous.counts);
        setActivityItems(previous.items);
        setError(err instanceof Error ? err.message : 'Unable to mark activity unread');
      }
    },
    [activityItems, api, applyReadState, counts, lastReadEventId, load, unreadExceptionIds],
  );

  const markAllRead = useCallback(async () => {
    const newestEventId = Math.max(
      0,
      ...activityItems.map((item) => {
        const id = Number(item.eventId);
        return Number.isSafeInteger(id) ? id : 0;
      }),
    );
    if (newestEventId <= 0 || markingRead) return;
    const previous = {
      cursor: lastReadEventId,
      exceptions: unreadExceptionIds,
      counts,
      items: activityItems,
    };
    setMarkingRead(true);
    setLastReadEventId(String(newestEventId));
    setUnreadExceptionIds([]);
    setCounts((prev) => ({ ...prev, unread: 0 }));
    setActivityItems((rows) => rows.map((row) => ({ ...row, unread: false })));
    try {
      const response = await api.markActivityRead(newestEventId);
      applyReadState(response);
      void load();
    } catch (err) {
      setLastReadEventId(previous.cursor);
      setUnreadExceptionIds(previous.exceptions);
      setCounts(previous.counts);
      setActivityItems(previous.items);
      setError(err instanceof Error ? err.message : 'Unable to mark activity read');
    } finally {
      setMarkingRead(false);
    }
  }, [activityItems, api, applyReadState, counts, lastReadEventId, load, markingRead, unreadExceptionIds]);

  const rows = useMemo<ActivityRow[]>(() => {
    const out: ActivityRow[] = [{ rowType: 'filter', key: 'filters' }];
    const filteredItems = activityItems.filter((item) =>
      matchesActivityFilter(item, filter, isActivityUnread(item, lastReadEventId, exceptionSet)),
    );
    if (filteredItems.length > 0) {
      out.push({ rowType: 'header', key: 'activity', label: 'Activity' });
      out.push(...filteredItems.map((activity) => ({ rowType: 'activity' as const, activity })));
    }
    return out;
  }, [activityItems, exceptionSet, filter, lastReadEventId]);

  const openActivity = (item: ActivityItem) => {
    const unread = isActivityUnread(item, lastReadEventId, exceptionSet);
    if (unread) void markItemRead(item);
    router.push(`/channel/${item.channelId}`);
  };

  const renderSwipeActions = (item: ActivityItem, unread: boolean) => {
    const actionLabel = unread ? 'Read' : 'Unread';
    const onPress = (event: GestureResponderEvent) => {
      event.stopPropagation?.();
      if (unread) void markItemRead(item);
      else void markItemUnread(item);
    };
    return (
      <View style={{ flexDirection: 'row', width: 88 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={unread ? 'Mark read' : 'Mark unread'}
          onPress={onPress}
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: unread ? colors.accent : colors.warning,
            paddingHorizontal: space.sm,
          }}
        >
          <Text style={{ color: colors.onAccent, fontSize: font.xs, fontWeight: '800' }}>{actionLabel}</Text>
        </Pressable>
      </View>
    );
  };

  const renderActivityItem = (item: ActivityItem) => {
    const time = formatRelativeTimestamp(item.createdAt) || item.createdAt;
    const exactTime = formatExactTimestamp(item.createdAt) || item.createdAt;
    const title = activityItemTitle(item);
    const marker = activityKindMarker(item.kind);
    // Single-line plain-text snippet: text truncation (not a pixel clip), so
    // descenders survive and the row scales with Dynamic Type.
    const snippet = plainMarkdownSnippet(
      decodeWireToDisplay(item.snippet, (id) => resolveUser(id)?.handle ?? null).text,
    );
    const unread = isActivityUnread(item, lastReadEventId, exceptionSet);

    const row = (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          unread ? 'Unread' : null,
          title,
          snippet,
          hideChannelLabel(item) ? null : `#${item.channelName}`,
          exactTime,
        ]
          .filter(Boolean)
          .join(', ')}
        onPress={() => openActivity(item)}
        onLongPress={() => {
          if (unread) void markItemRead(item);
          else void markItemUnread(item);
        }}
        delayLongPress={350}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
          backgroundColor: pressed ? colors.borderSoft : colors.bg,
        })}
      >
        <View
          style={{
            minWidth: 28,
            height: 24,
            borderRadius: radius.sm,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.bgElevated,
          }}
        >
          <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>{marker}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {unread && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />}
            <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>
              {title}
            </Text>
          </View>
          {snippet.length > 0 && (
            <Text style={{ color: colors.textSecondary, fontSize: font.sm }} numberOfLines={1}>
              {snippet}
            </Text>
          )}
          <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
            {hideChannelLabel(item) ? time : `#${item.channelName} · ${time}`}
          </Text>
        </View>
      </Pressable>
    );

    return (
      <Swipeable
        overshootRight={false}
        renderRightActions={() => renderSwipeActions(item, unread)}
        childrenContainerStyle={{ backgroundColor: colors.bg }}
      >
        {row}
      </Swipeable>
    );
  };

  const renderItem = ({ item }: { item: ActivityRow }) => {
    if (item.rowType === 'filter') {
      return (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 6,
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            paddingBottom: space.sm,
          }}
        >
          {FILTERS.map((entry) => {
            const selected = filter === entry.id;
            return (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Filter ${entry.label}`}
                onPress={() => setFilter(entry.id)}
                style={{
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  backgroundColor: selected ? colors.bgElevated : 'transparent',
                  borderWidth: 1,
                  borderColor: selected ? colors.border : colors.borderSoft,
                }}
              >
                <Text
                  style={{
                    color: selected ? colors.text : colors.textMuted,
                    fontSize: font.xs,
                    fontWeight: '700',
                  }}
                >
                  {entry.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      );
    }
    if (item.rowType === 'header') {
      return (
        <Text
          style={{
            color: colors.textMuted,
            fontSize: font.xs,
            fontWeight: '800',
            letterSpacing: 0.8,
            textTransform: 'uppercase',
            paddingHorizontal: space.lg,
            paddingTop: space.lg,
            paddingBottom: space.sm,
          }}
        >
          {item.label}
        </Text>
      );
    }
    return renderActivityItem(item.activity);
  };

  const hasFeedRows = rows.some((row) => row.rowType === 'activity');
  const showEmptyBody = !loading && !hasFeedRows;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader
        title="Inbox"
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Mark all read"
            onPress={() => void markAllRead()}
            disabled={markingRead || counts.unread === 0 || activityItems.length === 0}
            style={({ pressed }) => ({
              minHeight: 32,
              justifyContent: 'center',
              borderRadius: 8,
              paddingHorizontal: space.md,
              backgroundColor: pressed ? colors.borderSoft : 'transparent',
              opacity: markingRead || counts.unread === 0 || activityItems.length === 0 ? 0.5 : 1,
            })}
          >
            <Text style={{ color: colors.textMuted, fontSize: font.sm, fontWeight: '700' }}>
              {markingRead ? 'Marking…' : 'Mark all read'}
            </Text>
          </Pressable>
        }
      />
      <ConnectionBanner
        status={state.wsStatus}
        serverUrl={serverUrl}
        lastSyncedAt={state.lastSyncedAt}
        onSignInAgain={signInAgain}
      />
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) =>
            item.rowType === 'header' || item.rowType === 'filter'
              ? `${item.rowType}:${item.key}`
              : `activity:${item.activity.kind}:${item.activity.eventId}`
          }
          renderItem={renderItem}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void load()} tintColor={colors.textMuted} />
          }
          ListFooterComponent={
            showEmptyBody ? (
              error ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Activity failed. Tap to retry."
                  onPress={() => void load()}
                  style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: space.xl,
                    minHeight: navigationTargetSize,
                  }}
                >
                  <Text style={{ color: colors.danger, fontSize: font.sm }}>Activity failed — tap to retry</Text>
                </Pressable>
              ) : (
                <View
                  style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: space.xl,
                    gap: space.sm,
                    minHeight: 200,
                  }}
                >
                  <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }}>
                    {activityItems.length === 0
                      ? "You're all caught up"
                      : filter === 'unread'
                        ? 'No unread activity'
                        : 'Nothing in this view'}
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center', lineHeight: 20 }}>
                    {activityItems.length === 0
                      ? 'Mentions, DMs, reactions, thread replies, invites, and calls will appear here.'
                      : 'Try another filter, or mark items unread to keep them here.'}
                  </Text>
                </View>
              )
            ) : nextActivityCursor ? (
              <View style={{ padding: space.lg, paddingBottom: 96 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Load more activity"
                  onPress={() => void loadMoreActivity()}
                  disabled={loadingMore}
                  style={({ pressed }) => ({
                    alignSelf: 'flex-start',
                    minHeight: navigationTargetSize,
                    justifyContent: 'center',
                    borderRadius: 8,
                    paddingHorizontal: space.md,
                    backgroundColor: pressed ? colors.borderSoft : colors.bgElevated,
                    opacity: loadingMore ? 0.6 : 1,
                  })}
                >
                  <Text style={{ color: colors.textMuted, fontSize: font.sm, fontWeight: '700' }}>
                    {loadingMore ? 'Loading...' : 'Load more'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ height: 96 }} />
            )
          }
          contentContainerStyle={showEmptyBody ? { flexGrow: 1 } : undefined}
        />
      )}
    </View>
  );
}
