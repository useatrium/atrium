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
  isTerminalSessionStatus,
  matchesActivityFilter,
  sessionAttentionKind,
  sessionGlanceClockLabel,
  type Session,
  type SessionListItem,
} from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { glanceColor, listItemGlance } from '../../../src/lib/sessionGlance';
import { font, radius, space, useTheme } from '../../../src/lib/theme';
import { ConnectionBanner } from '../../../src/components/bits';
import { MobileHeader } from '../../../src/components/MobileHeader';
import { navigationTargetSize } from '../../../src/components/PlatformTabBar';

interface DisplaySession extends SessionListItem {
  live?: Session;
}

type ActivityRow =
  | { rowType: 'header'; key: string; label: string; tone: 'attention' | 'default' }
  | { rowType: 'filter'; key: string }
  | { rowType: 'session'; session: DisplaySession }
  | { rowType: 'activity'; activity: ActivityItem; attention: boolean };

const FILTERS: Array<{ id: ActivityFeedFilter; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'unread', label: 'Unread' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

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
  const sessionTitle = item.sessionTitle ?? 'Agent';
  if (item.kind === 'mention') return `${item.actorName ?? 'Someone'} mentioned you`;
  if (item.kind === 'dm') {
    return isGroupDm(item)
      ? `${item.actorName ?? 'Someone'} messaged the group`
      : `${item.actorName ?? 'Someone'} sent a DM`;
  }
  if (item.kind === 'thread_reply') return `${item.actorName ?? 'Someone'} replied in a thread`;
  if (item.kind === 'agent_question') {
    return item.sessionTitle ? `${item.sessionTitle} · needs your answer` : 'Agent needs your input';
  }
  if (item.kind === 'session_completed') {
    return item.sessionTitle ? `${item.sessionTitle} · completed` : 'Agent session completed';
  }
  if (item.kind === 'session_failed') return `${sessionTitle} failed`;
  if (item.kind === 'agent_auth') return `${sessionTitle} is blocked — reconnect provider`;
  if (item.kind === 'reaction') return `${item.actorName ?? 'Someone'} reacted to your message`;
  if (item.kind === 'channel_invite') return `${item.actorName ?? 'Someone'} added you`;
  if (item.kind === 'seat_request') return `${item.actorName ?? 'Someone'} wants to drive · ${sessionTitle}`;
  if (item.kind === 'missed_call') return `${item.actorName ?? 'Someone'} called you`;
  if (item.kind === 'call_declined') return `${item.actorName ?? 'Someone'} called · you declined`;
  return 'Activity';
}

/** @deprecated Prefer activityKindMarker from @atrium/surface-client */
export function activityItemMarker(item: ActivityItem): string {
  return activityKindMarker(item.kind);
}

// One pinned row per session: a live blocked session row wins over feed items,
// and among feed items the newest attention state wins.
export function partitionRows(
  liveAttention: DisplaySession[],
  items: readonly ActivityItem[],
): { attention: ActivityRow[]; history: ActivityRow[] } {
  const pinnedSessionIds = new Set(liveAttention.map((session) => session.id));
  const attention: ActivityRow[] = liveAttention.map((session) => ({ rowType: 'session', session }));
  const history: ActivityRow[] = [];
  for (const item of items) {
    const canPin = item.attention && !!item.sessionId && !pinnedSessionIds.has(item.sessionId);
    if (canPin && item.sessionId) {
      pinnedSessionIds.add(item.sessionId);
      attention.push({ rowType: 'activity', activity: item, attention: true });
    } else {
      history.push({ rowType: 'activity', activity: item, attention: false });
    }
  }
  return { attention, history };
}

function parseEventId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isHistoryKind(kind: ActivityItem['kind']): boolean {
  return kind !== 'agent_question' && kind !== 'agent_auth';
}

export default function ActivityScreen() {
  const { api, state, resolveUser } = useChat();
  const { colors } = useTheme();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [nextActivityCursor, setNextActivityCursor] = useState<string | null>(null);
  const [lastReadEventId, setLastReadEventId] = useState('0');
  const [unreadExceptionIds, setUnreadExceptionIds] = useState<string[]>([]);
  const [counts, setCounts] = useState<ActivityCounts>({ attention: 0, unread: 0 });
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
        const [sessionRes, activityRes] = await Promise.all([
          api.listSessions({ status: 'all', limit: 100 }),
          api.getActivity(),
        ]);
        setSessions(sessionRes.sessions);
        setActivityItems(activityRes.items);
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
      setActivityItems((prev) => [...prev, ...res.items]);
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
      setCounts((prev) => ({ attention: prev.attention, unread: Math.max(0, prev.unread - 1) }));
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
      setCounts((prev) => ({ attention: prev.attention, unread: Math.min(99, prev.unread + 1) }));
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
    setCounts((prev) => ({ attention: prev.attention, unread: 0 }));
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

  // Only unresolved agent states belong in the pinned tier. Healthy progress
  // stays on Agents; everything else is history under the watermark.
  const rows = useMemo<ActivityRow[]>(() => {
    const merged = sessions.map((s) => ({ ...s, live: state.sessions[s.id] }));
    // Terminal sessions (failed/cancelled) are represented by their feed items,
    // whose attention flag honors the read watermark — a live row would pin a
    // failure forever with no way to acknowledge it.
    const liveAttention = merged.filter((s) => {
      const status = s.live?.status ?? s.status;
      if (isTerminalSessionStatus(status)) return false;
      if (s.live) return sessionAttentionKind(s.live) !== null;
      return (
        sessionAttentionKind({
          status: s.status,
          pendingQuestion: null,
          providerAuthRequired: null,
          pendingSeatRequests: [],
        }) !== null
      );
    });
    const { attention, history } = partitionRows(liveAttention, activityItems);

    const filterRow = (row: ActivityRow): boolean => {
      if (row.rowType !== 'activity') {
        // Live session pins only appear in inbox/all/unread (not Done).
        if (filter === 'done') return false;
        if (filter === 'unread') return true; // treat live pins as needing eyes
        return true;
      }
      const unread = isActivityUnread(row.activity, lastReadEventId, exceptionSet);
      return matchesActivityFilter(row.activity, filter, unread);
    };

    const filteredAttention = attention.filter(filterRow);
    const filteredHistory = history.filter(filterRow);

    const out: ActivityRow[] = [{ rowType: 'filter', key: 'filters' }];
    if (filteredAttention.length > 0) {
      out.push({
        rowType: 'header',
        key: 'needs-attention',
        label: `Needs attention · ${filteredAttention.length}`,
        tone: 'attention',
      });
      out.push(...filteredAttention);
    }
    if (filteredHistory.length > 0) {
      out.push({
        rowType: 'header',
        key: 'activity',
        label: filter === 'done' ? 'Done' : 'Activity',
        tone: 'default',
      });
      out.push(...filteredHistory);
    }
    return out;
  }, [activityItems, exceptionSet, filter, lastReadEventId, sessions, state.sessions]);

  const openActivity = async (item: ActivityItem) => {
    const unread = isActivityUnread(item, lastReadEventId, exceptionSet);
    if (unread && isHistoryKind(item.kind) && !item.attention) {
      void markItemRead(item);
    }

    if (
      item.kind !== 'agent_question' &&
      item.kind !== 'session_completed' &&
      item.kind !== 'session_failed' &&
      item.kind !== 'agent_auth'
    ) {
      router.push(`/channel/${item.channelId}`);
      return;
    }
    const eventId = parseEventId(item.eventId);
    if (eventId == null) {
      router.push(`/channel/${item.channelId}`);
      return;
    }
    try {
      const { events } = await api.messages(item.channelId, { afterId: eventId - 1, limit: 1 });
      const event = events.find((candidate) => candidate.id === eventId);
      const sessionId = event && typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : null;
      router.push(sessionId ? `/session/${sessionId}` : `/channel/${item.channelId}`);
    } catch {
      router.push(`/channel/${item.channelId}`);
    }
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

  const renderActivityItem = (item: ActivityItem, attention: boolean) => {
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
    const danger = attention && item.kind === 'session_failed';
    const chipBackground = attention ? (danger ? colors.dangerSurface : colors.warningSurface) : colors.bgElevated;
    const chipColor = attention ? (danger ? colors.danger : colors.warning) : colors.textMuted;

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
        onPress={() => void openActivity(item)}
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
          borderLeftWidth: attention ? 2 : 0,
          borderLeftColor: attention ? (danger ? colors.danger : colors.warning) : 'transparent',
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
            backgroundColor: chipBackground,
          }}
        >
          <Text style={{ color: chipColor, fontSize: font.xs, fontWeight: '800' }}>{marker}</Text>
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
            color: item.tone === 'attention' ? colors.warning : colors.textMuted,
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
    if (item.rowType === 'activity') return renderActivityItem(item.activity, item.attention);
    const session = item.session;
    const now = Date.now();
    const glance = listItemGlance(session, session.live, now);
    const clock = glance.clock?.mode === 'waiting' ? sessionGlanceClockLabel(glance, now) : null;
    const stateWord = clock ? `${glance.label} · ${clock}` : glance.label;
    const title = session.live?.title ?? session.title;
    const time = formatRelativeTimestamp(session.createdAt) || session.createdAt;
    const exactTime = formatExactTimestamp(session.createdAt) || session.createdAt;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${glance.label}, #${session.channelName}, started ${exactTime}`}
        onPress={() => router.push(`/session/${session.id}`)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
          borderLeftWidth: 2,
          borderLeftColor: colors.warning,
          backgroundColor: pressed ? colors.borderSoft : 'transparent',
        })}
      >
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: glanceColor(glance.kind, colors) }} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }} numberOfLines={1}>
            {title}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
            {stateWord} · #{session.channelName} · {time}
          </Text>
        </View>
      </Pressable>
    );
  };

  const hasFeedRows = rows.some((row) => row.rowType === 'activity' || row.rowType === 'session');
  const showEmptyBody = !loading && !hasFeedRows;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader
        title="Attention"
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
      <ConnectionBanner status={state.wsStatus} />
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
              : item.rowType === 'session'
                ? `session:${item.session.id}`
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
                      : filter === 'done'
                        ? 'No completed sessions'
                        : filter === 'unread'
                          ? 'No unread activity'
                          : 'Nothing in this view'}
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center', lineHeight: 20 }}>
                    {activityItems.length === 0
                      ? 'Mentions, DMs, agent questions, failed work, and recent completions will appear here.'
                      : filter === 'done'
                        ? 'Completed agent work lives under Done. Switch to Inbox or All for the rest.'
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
