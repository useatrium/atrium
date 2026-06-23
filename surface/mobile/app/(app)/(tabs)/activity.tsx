// Activity — the notifications hub. v1 surfaces agent events (sessions that are
// running or need your attention) from the existing sessions feed; mentions &
// reactions land here in a later increment once a server feed exists.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  isTerminalSessionStatus,
  type Session,
  type SessionListItem,
  type SessionStatus,
} from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { font, space, useTheme, type Colors } from '../../../src/lib/theme';
import { ConnectionBanner } from '../../../src/components/bits';
import { MobileHeader } from '../../../src/components/MobileHeader';

interface DisplaySession extends SessionListItem {
  live?: Session;
}

function statusColor(status: SessionStatus, colors: Colors): string {
  if (status === 'completed') return colors.online;
  if (status === 'failed' || status === 'cancelled') return colors.danger;
  if (status === 'running') return colors.accent;
  return colors.warning;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function ActivityScreen() {
  const { api, state, queuedChangesCount } = useChat();
  const { colors } = useTheme();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'refresh') => {
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const res = await api.listSessions({ status: 'all', limit: 100 });
        setSessions(res.sessions);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load activity');
      } finally {
        if (mode === 'initial') setLoading(false);
        else setRefreshing(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  // "Needs attention": non-terminal sessions (running / queued / awaiting input),
  // newest first. Live state overrides the fetched snapshot.
  const rows = useMemo<DisplaySession[]>(() => {
    const merged = sessions.map((s) => ({ ...s, live: state.sessions[s.id] }));
    return merged
      .filter((s) => {
        const status = s.live?.status ?? s.status;
        return !isTerminalSessionStatus(status);
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [sessions, state.sessions]);

  const renderItem = ({ item }: { item: DisplaySession }) => {
    const status = item.live?.status ?? item.status;
    const title = item.live?.title ?? item.title;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${status}, #${item.channelName}`}
        onPress={() => router.push(`/session/${item.id}`)}
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
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor(status, colors) }}
        />
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }} numberOfLines={1}>
            {title}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
            {status} · #{item.channelName} · {relativeTime(item.createdAt)}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title="Activity" />
      <ConnectionBanner status={state.wsStatus} queuedChangesCount={queuedChangesCount} />
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
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
                style={{ alignItems: 'center', justifyContent: 'center', padding: space.xl, minHeight: 44 }}
              >
                <Text style={{ color: colors.danger, fontSize: font.sm }}>Activity failed — tap to retry</Text>
              </Pressable>
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm }}>
                <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }}>You&rsquo;re all caught up</Text>
                <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center', lineHeight: 20 }}>
                  Agents you start show up here while they&rsquo;re working. Mentions &amp; reactions are coming soon.
                </Text>
              </View>
            )
          }
          contentContainerStyle={rows.length === 0 ? { flexGrow: 1 } : undefined}
          ListFooterComponent={<View style={{ height: 96 }} />}
        />
      )}
    </View>
  );
}
