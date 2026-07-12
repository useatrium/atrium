import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  type ActivityCounts,
  type ActivityItem,
  decodeWireToDisplay,
  plainMarkdownSnippet,
  formatExactTimestamp,
  formatRelativeTimestamp,
  isTerminalSessionStatus,
  sessionAttentionKind,
  type Session,
  type SessionListItem,
  type SessionStatus,
} from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { font, space, useTheme, type Colors } from '../../../src/lib/theme';
import { ConnectionBanner } from '../../../src/components/bits';
import { MobileHeader } from '../../../src/components/MobileHeader';
import { navigationTargetSize } from '../../../src/components/PlatformTabBar';

interface DisplaySession extends SessionListItem {
  live?: Session;
}

type ActivityRow =
  | { rowType: 'header'; key: string; label: string; tone: 'attention' | 'default' }
  | { rowType: 'session'; session: DisplaySession }
  | { rowType: 'activity'; activity: ActivityItem; attention: boolean };

function statusColor(status: SessionStatus, colors: Colors): string {
  if (status === 'completed') return colors.online;
  if (status === 'failed' || status === 'cancelled') return colors.danger;
  if (status === 'running') return colors.accent;
  return colors.warning;
}

function isUnread(item: ActivityItem, lastReadEventId: string): boolean {
  const eventId = Number(item.eventId);
  const watermark = Number(lastReadEventId);
  return Number.isSafeInteger(eventId) && Number.isSafeInteger(watermark) && eventId > watermark;
}

// DM/GDM channel names are internal keys (`dm:<ids>` / `gdm:<ids>`), so the key
// prefix is the only signal that a "dm" item came from a group conversation.
function isGroupDm(item: ActivityItem): boolean {
  return item.kind === 'dm' && item.channelName.startsWith('gdm:');
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
  return 'Activity';
}

export function activityItemMarker(item: ActivityItem): string {
  if (item.kind === 'mention') return '@';
  if (item.kind === 'dm') return 'DM';
  if (item.kind === 'thread_reply') return '↩';
  if (item.kind === 'agent_question') return '?';
  if (item.kind === 'session_completed') return 'OK';
  if (item.kind === 'session_failed') return '!';
  if (item.kind === 'agent_auth') return '⚿';
  if (item.kind === 'reaction') return '☺';
  if (item.kind === 'channel_invite') return '+';
  if (item.kind === 'seat_request') return '⇄';
  return '•';
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

export default function ActivityScreen() {
  const { api, state, resolveUser } = useChat();
  const { colors } = useTheme();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [nextActivityCursor, setNextActivityCursor] = useState<string | null>(null);
  const [lastReadEventId, setLastReadEventId] = useState('0');
  const [counts, setCounts] = useState<ActivityCounts>({ attention: 0, unread: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const markAllRead = useCallback(async () => {
    const newestEventId = Math.max(
      0,
      ...activityItems.map((item) => {
        const id = Number(item.eventId);
        return Number.isSafeInteger(id) ? id : 0;
      }),
    );
    if (newestEventId <= 0 || markingRead) return;
    const previousCursor = lastReadEventId;
    setMarkingRead(true);
    setLastReadEventId(String(newestEventId));
    setCounts((prev) => ({ attention: prev.attention, unread: 0 }));
    try {
      const response = await api.markActivityRead(newestEventId);
      setLastReadEventId(response.lastReadEventId);
      void load();
    } catch (err) {
      setLastReadEventId(previousCursor);
      setError(err instanceof Error ? err.message : 'Unable to mark activity read');
    } finally {
      setMarkingRead(false);
    }
  }, [activityItems, api, lastReadEventId, load, markingRead]);

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
    const out: ActivityRow[] = [];
    if (attention.length > 0) {
      out.push({
        rowType: 'header',
        key: 'needs-attention',
        label: `Needs attention · ${attention.length}`,
        tone: 'attention',
      });
      out.push(...attention);
    }
    if (history.length > 0) {
      out.push({ rowType: 'header', key: 'activity', label: 'Activity', tone: 'default' });
      out.push(...history);
    }
    return out;
  }, [activityItems, sessions, state.sessions]);

  const openActivity = async (item: ActivityItem) => {
    if (
      item.kind !== 'agent_question' &&
      item.kind !== 'session_completed' &&
      item.kind !== 'session_failed' &&
      item.kind !== 'agent_auth'
    ) {
      router.push(`/channel/${item.channelId}`);
      return;
    }
    const eventId = Number(item.eventId);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) {
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

  const renderActivityItem = (item: ActivityItem, attention: boolean) => {
    const time = formatRelativeTimestamp(item.createdAt) || item.createdAt;
    const exactTime = formatExactTimestamp(item.createdAt) || item.createdAt;
    const title = activityItemTitle(item);
    const marker = activityItemMarker(item);
    // Single-line plain-text snippet: text truncation (not a pixel clip), so
    // descenders survive and the row scales with Dynamic Type.
    const snippet = plainMarkdownSnippet(
      decodeWireToDisplay(item.snippet, (id) => resolveUser(id)?.handle ?? null).text,
    );
    const unread = isUnread(item, lastReadEventId) && !item.muted;
    const danger = attention && item.kind === 'session_failed';
    const chipBackground = attention ? (danger ? colors.dangerSurface : colors.warningSurface) : colors.bgElevated;
    const chipColor = attention ? (danger ? colors.danger : colors.warning) : colors.textMuted;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          unread ? 'Unread' : null,
          title,
          snippet,
          item.kind !== 'dm' ? `#${item.channelName}` : null,
          exactTime,
        ]
          .filter(Boolean)
          .join(', ')}
        onPress={() => void openActivity(item)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.lg,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
          borderLeftWidth: attention ? 2 : 0,
          borderLeftColor: attention ? (danger ? colors.danger : colors.warning) : 'transparent',
          backgroundColor: pressed ? colors.borderSoft : 'transparent',
        })}
      >
        <View
          style={{
            minWidth: 28,
            height: 24,
            borderRadius: 6,
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
            {/* DM channel names are internal keys; the title already names the sender. */}
            {item.kind === 'dm' ? time : `#${item.channelName} · ${time}`}
          </Text>
        </View>
      </Pressable>
    );
  };

  const renderItem = ({ item }: { item: ActivityRow }) => {
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
    const status = session.live?.status ?? session.status;
    const title = session.live?.title ?? session.title;
    const time = formatRelativeTimestamp(session.createdAt) || session.createdAt;
    const exactTime = formatExactTimestamp(session.createdAt) || session.createdAt;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${status}, #${session.channelName}, started ${exactTime}`}
        onPress={() => router.push(`/session/${session.id}`)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.lg,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
          borderLeftWidth: 2,
          borderLeftColor: colors.warning,
          backgroundColor: pressed ? colors.borderSoft : 'transparent',
        })}
      >
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor(status, colors) }} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }} numberOfLines={1}>
            {title}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
            {status} · #{session.channelName} · {time}
          </Text>
        </View>
      </Pressable>
    );
  };

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
            item.rowType === 'header'
              ? `header:${item.key}`
              : item.rowType === 'session'
                ? `session:${item.session.id}`
                : `activity:${item.activity.kind}:${item.activity.eventId}`
          }
          renderItem={renderItem}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void load()} tintColor={colors.textMuted} />
          }
          ListEmptyComponent={
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
                style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm }}
              >
                <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }}>You're all caught up</Text>
                <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center', lineHeight: 20 }}>
                  Mentions, DMs, agent questions, failed work, and recent completions will appear here.
                </Text>
              </View>
            )
          }
          contentContainerStyle={rows.length === 0 ? { flexGrow: 1 } : undefined}
          ListFooterComponent={
            nextActivityCursor ? (
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
        />
      )}
    </View>
  );
}
