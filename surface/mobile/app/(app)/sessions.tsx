import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import {
  formatCost,
  isTerminalSessionStatus,
  type Session,
  type SessionListItem,
  type SessionStatus,
} from '@atrium/surface-client';
import { useChat } from '../../src/lib/chat';
import { font, radius, space, useTheme, type Colors } from '../../src/lib/theme';
import { ConnectionBanner } from '../../src/components/bits';

interface DisplaySession extends SessionListItem {
  live?: Session;
}

function statusColor(status: SessionStatus, colors: Colors): string {
  if (status === 'completed') return colors.online;
  if (status === 'failed' || status === 'cancelled') return colors.danger;
  if (status === 'running') return colors.accent;
  return colors.warning;
}

function StatusChip({ status }: { status: SessionStatus }) {
  const { colors } = useTheme();
  const color = statusColor(status, colors);
  const label = status === 'spawning' ? 'STARTING' : status.toUpperCase();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: color,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ color, fontSize: font.xs, fontWeight: '800' }}>{label}</Text>
    </View>
  );
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function displayFields(item: DisplaySession) {
  const live = item.live;
  return {
    title: live?.title ?? item.title,
    status: live?.status ?? item.status,
    costUsd: Math.max(live?.costUsd ?? 0, item.costUsd),
    createdAt: live?.createdAt ?? item.createdAt,
    completedAt: live?.completedAt ?? item.completedAt,
  };
}

export default function SessionsScreen() {
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
        setError(err instanceof Error ? err.message : 'Unable to load sessions');
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

  const rows = useMemo<DisplaySession[]>(
    () => sessions.map((session) => ({ ...session, live: state.sessions[session.id] })),
    [sessions, state.sessions],
  );

  const renderItem = ({ item }: { item: DisplaySession }) => {
    const fields = displayFields(item);
    const terminal = isTerminalSessionStatus(fields.status);
    const time = relativeTime(fields.completedAt ?? fields.createdAt);
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${fields.title}, ${fields.status}, #${item.channelName}, ${terminal ? time : `started ${time}`}${fields.costUsd > 0 ? `, ${formatCost(fields.costUsd)}` : ''}`}
        onPress={() => router.push(`/session/${item.id}`)}
        style={({ pressed }) => ({
          paddingHorizontal: space.lg,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
          backgroundColor: pressed ? colors.borderSoft : 'transparent',
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <StatusChip status={fields.status} />
          <Text
            style={{
              flex: 1,
              color: colors.text,
              fontSize: font.md,
              fontWeight: '700',
            }}
            numberOfLines={1}
          >
            {fields.title}
          </Text>
        </View>
        <View
          style={{
            marginTop: 6,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Text style={{ flex: 1, color: colors.textMuted, fontSize: font.sm }} numberOfLines={1}>
            #{item.channelName}
          </Text>
          <Text style={{ color: colors.textFaint, fontSize: font.xs }}>
            {terminal ? time : `started ${time}`}
          </Text>
          {fields.costUsd > 0 && (
            <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>
              {formatCost(fields.costUsd)}
            </Text>
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          title: 'Sessions',
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
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
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void load()}
              tintColor={colors.textMuted}
            />
          }
          ListEmptyComponent={
            error ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sessions failed. Tap to retry."
                onPress={() => void load()}
                style={{ alignItems: 'center', justifyContent: 'center', padding: space.xl, minHeight: 44 }}
              >
                <Text style={{ color: colors.danger, fontSize: font.sm }}>
                  Sessions failed — tap to retry
                </Text>
              </Pressable>
            ) : (
              <View style={{ alignItems: 'center', padding: space.xl }}>
                <Text style={{ color: colors.textMuted, fontSize: font.sm }}>No sessions yet</Text>
              </View>
            )
          }
          contentContainerStyle={rows.length === 0 ? { flex: 1 } : undefined}
        />
      )}
      {error && rows.length > 0 && (
        <View
          style={{
            margin: space.lg,
            borderRadius: radius.sm,
            borderWidth: 1,
            borderColor: colors.dangerBorder,
            padding: space.sm,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: font.xs }}>{error}</Text>
        </View>
      )}
    </View>
  );
}
