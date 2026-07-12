import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  type ActivityItem,
  formatExactTimestamp,
  formatRelativeTimestamp,
  sessionAttentionKind,
  type Session,
  type SessionListItem,
  type SessionStatus,
} from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { font, space, useTheme, type Colors } from '../../../src/lib/theme';
import { ConnectionBanner } from '../../../src/components/bits';
import { MobileHeader } from '../../../src/components/MobileHeader';
import { MarkdownText } from '../../../src/components/Markdown';
import { navigationTargetSize } from '../../../src/components/PlatformTabBar';

interface DisplaySession extends SessionListItem {
  live?: Session;
}

type ActivityRow = { rowType: 'session'; session: DisplaySession } | { rowType: 'activity'; activity: ActivityItem };

function statusColor(status: SessionStatus, colors: Colors): string {
  if (status === 'completed') return colors.online;
  if (status === 'failed' || status === 'cancelled') return colors.danger;
  if (status === 'running') return colors.accent;
  return colors.warning;
}

export default function ActivityScreen() {
  const { api, state } = useChat();
  const { colors } = useTheme();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [nextActivityCursor, setNextActivityCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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

  // Only unresolved agent states belong in Attention. Healthy progress stays
  // visible on Agents, while completion/mention/DM/question activity comes from
  // the server feed (which owns its read semantics).
  const rows = useMemo<ActivityRow[]>(() => {
    const merged = sessions.map((s) => ({ ...s, live: state.sessions[s.id] }));
    const attention = merged
      .filter((s) => {
        if (s.live) return sessionAttentionKind(s.live) !== null;
        return sessionAttentionKind({
          status: s.status,
          pendingQuestion: null,
          providerAuthRequired: null,
          pendingSeatRequests: [],
        }) !== null;
      })
      .map((session): ActivityRow => ({ rowType: 'session', session }));
    const feedRows = activityItems.map((activity): ActivityRow => ({ rowType: 'activity', activity }));
    return [...attention, ...feedRows].sort((a, b) => {
      const aDate = a.rowType === 'session' ? a.session.createdAt : a.activity.createdAt;
      const bDate = b.rowType === 'session' ? b.session.createdAt : b.activity.createdAt;
      return Date.parse(bDate) - Date.parse(aDate);
    });
  }, [activityItems, sessions, state.sessions]);

  const openActivity = async (item: ActivityItem) => {
    if (item.kind !== 'agent_question' && item.kind !== 'session_completed') {
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

  const renderActivityItem = (item: ActivityItem) => {
    const time = formatRelativeTimestamp(item.createdAt) || item.createdAt;
    const exactTime = formatExactTimestamp(item.createdAt) || item.createdAt;
    const title =
      item.kind === 'mention'
        ? `${item.actorName ?? 'Someone'} mentioned you`
        : item.kind === 'dm'
          ? `${item.actorName ?? 'Someone'} sent a DM`
          : item.kind === 'agent_question'
            ? 'Agent needs your input'
            : 'Agent session completed';
    const marker =
      item.kind === 'mention' ? '@' : item.kind === 'dm' ? 'DM' : item.kind === 'agent_question' ? '?' : 'OK';
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          item.kind === 'dm' ? `${title}, ${exactTime}` : `${title}, #${item.channelName}, ${exactTime}`
        }
        onPress={() => void openActivity(item)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.lg,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
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
            backgroundColor: colors.bgElevated,
          }}
        >
          <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>{marker}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }} numberOfLines={1}>
            {title}
          </Text>
          <View style={{ maxHeight: 22, overflow: 'hidden' }}>
            <MarkdownText text={item.snippet} variant="compact" />
          </View>
          <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
            {/* DM channel names are internal keys; the title already names the sender. */}
            {item.kind === 'dm' ? time : `#${item.channelName} · ${time}`}
          </Text>
        </View>
      </Pressable>
    );
  };

  const renderItem = ({ item }: { item: ActivityRow }) => {
    if (item.rowType === 'activity') return renderActivityItem(item.activity);
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
      <MobileHeader title="Attention" />
      <ConnectionBanner status={state.wsStatus} />
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) =>
            item.rowType === 'session'
              ? `session:${item.session.id}`
              : `activity:${item.activity.kind}:${item.activity.eventId}`
          }
          renderItem={renderItem}
          ListHeaderComponent={
            rows.length > 0 ? (
              <View
                style={{
                  paddingHorizontal: space.lg,
                  paddingTop: space.lg,
                  paddingBottom: space.md,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.borderSoft,
                }}
              >
                <Text
                  style={{
                    color: colors.text,
                    fontSize: font.md,
                    fontWeight: '800',
                    marginBottom: 4,
                  }}
                >
                  Needs your attention
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: font.sm, lineHeight: 20 }}>
                  Mentions, DMs, agent questions, failed work, and recent completions.
                </Text>
              </View>
            ) : null
          }
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void load()} tintColor={colors.textMuted} />
          }
          ListEmptyComponent={
            error ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Activity failed. Tap to retry."
                onPress={() => void load()}
                style={{ alignItems: 'center', justifyContent: 'center', padding: space.xl, minHeight: navigationTargetSize }}
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
