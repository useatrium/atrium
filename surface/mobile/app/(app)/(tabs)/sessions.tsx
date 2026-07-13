import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, SectionList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  formatExactTimestamp,
  formatCost,
  formatRelativeTimestamp,
  isTerminalSessionStatus,
  sessionGlanceClockLabel,
  type Session,
  type SessionGlance,
  type SessionListItem,
} from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { glanceColor, listItemGlance } from '../../../src/lib/sessionGlance';
import { font, radius, space, useTheme } from '../../../src/lib/theme';
import { ConnectionBanner } from '../../../src/components/bits';
import { MobileHeader } from '../../../src/components/MobileHeader';

interface DisplaySession extends SessionListItem {
  live?: Session;
}

type SessionSection = { key: string; title: string; data: DisplaySession[] };

function StatusChip({ glance }: { glance: SessionGlance }) {
  const { colors } = useTheme();
  const color = glanceColor(glance.kind, colors);
  // The chip carries a clock only while a person is being waited on — the
  // coarse "12m" stays honest between list refreshes; a seconds clock lies.
  const clock = glance.clock?.mode === 'waiting' ? sessionGlanceClockLabel(glance, Date.now()) : null;
  const label = `${glance.label.toUpperCase()}${clock ? ` · ${clock}` : ''}`;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: color,
        paddingHorizontal: space.sm,
        paddingVertical: 3,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ color, fontSize: font.xs, fontWeight: '800' }}>{label}</Text>
    </View>
  );
}

function displayFields(item: DisplaySession) {
  const live = item.live;
  return {
    title: live?.title ?? item.title,
    status: live?.status ?? item.status,
    costUsd: Math.max(live?.costUsd ?? 0, item.costUsd),
    createdAt: live?.createdAt ?? item.createdAt,
    completedAt: live?.completedAt ?? item.completedAt,
    archivedAt: live?.archivedAt ?? item.archivedAt,
    pinned: live?.pinned ?? item.pinned,
  };
}

function needsAttention(item: DisplaySession): boolean {
  return item.live?.pendingQuestion != null || item.live?.providerAuthRequired != null;
}

function freshness(item: DisplaySession): number {
  const fields = displayFields(item);
  const parsed = Date.parse(fields.completedAt ?? fields.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function groupMobileSessions(rows: DisplaySession[]): SessionSection[] {
  const pinned: DisplaySession[] = [];
  const needsYou: DisplaySession[] = [];
  const active: DisplaySession[] = [];
  const recent: DisplaySession[] = [];
  for (const row of rows) {
    const fields = displayFields(row);
    if (fields.archivedAt != null) continue; // archived rows live behind the disclosure
    if (fields.pinned) pinned.push(row);
    else if (needsAttention(row)) needsYou.push(row);
    else if (isTerminalSessionStatus(fields.status)) recent.push(row);
    else active.push(row);
  }
  const byNewest = (a: DisplaySession, b: DisplaySession) => freshness(b) - freshness(a);
  pinned.sort(byNewest);
  needsYou.sort(byNewest);
  active.sort(byNewest);
  recent.sort(byNewest);
  return [
    { key: 'pinned', title: 'Pinned', data: pinned },
    { key: 'needs', title: 'Needs you', data: needsYou },
    { key: 'active', title: 'Active', data: active },
    { key: 'recent', title: 'Recent', data: recent },
  ].filter((section) => section.data.length > 0);
}

export default function SessionsScreen() {
  const { api, state, startDemoSession, setSessionArchived, setSessionPinned } = useChat();
  const { colors } = useTheme();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<SessionListItem[] | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'refresh') => {
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const res = await api.listSessions({ status: 'all', limit: 100 });
        setSessions(res.sessions);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load agents');
      } finally {
        if (mode === 'initial') setLoading(false);
        else setRefreshing(false);
      }
    },
    [api],
  );

  const loadArchived = useCallback(async () => {
    setArchivedLoading(true);
    try {
      const res = await api.listSessions({ status: 'archived', limit: 100 });
      setArchived(res.sessions);
    } catch {
      setArchived((prev) => prev ?? []);
    } finally {
      setArchivedLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load('initial');
  }, [load]);

  useEffect(() => {
    if (archivedOpen && archived == null) void loadArchived();
  }, [archived, archivedOpen, loadArchived]);

  const togglePin = useCallback(
    (item: DisplaySession) => {
      const fields = displayFields(item);
      setSessionPinned(item.id, !fields.pinned, fields.pinned);
      setSessions((rows) => rows.map((row) => (row.id === item.id ? { ...row, pinned: !fields.pinned } : row)));
    },
    [setSessionPinned],
  );

  const toggleArchive = useCallback(
    (item: DisplaySession) => {
      const fields = displayFields(item);
      const archive = fields.archivedAt == null;
      setSessionArchived(item.id, archive, fields.archivedAt);
      const archivedAt = archive ? new Date().toISOString() : null;
      if (archive) {
        setSessions((rows) => rows.filter((row) => row.id !== item.id));
        setArchived((rows) => (rows == null ? rows : [{ ...item, live: undefined, archivedAt }, ...rows]));
      } else {
        setArchived((rows) => rows?.filter((row) => row.id !== item.id) ?? rows);
        setSessions((rows) => [{ ...item, live: undefined, archivedAt }, ...rows.filter((row) => row.id !== item.id)]);
      }
    },
    [setSessionArchived],
  );

  const openRowActions = useCallback(
    (item: DisplaySession) => {
      const fields = displayFields(item);
      const isArchived = fields.archivedAt != null;
      Alert.alert(fields.title, undefined, [
        ...(isArchived ? [] : [{ text: fields.pinned ? 'Unpin' : 'Pin', onPress: () => togglePin(item) }]),
        { text: isArchived ? 'Unarchive' : 'Archive', onPress: () => toggleArchive(item) },
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    },
    [toggleArchive, togglePin],
  );

  const rows = useMemo<DisplaySession[]>(
    () => sessions.map((session) => ({ ...session, live: state.sessions[session.id] })),
    [sessions, state.sessions],
  );
  const sections = useMemo(() => groupMobileSessions(rows), [rows]);
  const archivedRows = useMemo<DisplaySession[]>(
    () => (archived ?? []).map((session) => ({ ...session, live: state.sessions[session.id] })),
    [archived, state.sessions],
  );
  const hasChannels = state.channels.length > 0;

  const renderRow = (item: DisplaySession) => {
    const fields = displayFields(item);
    const terminal = isTerminalSessionStatus(fields.status);
    const timestamp = fields.completedAt ?? fields.createdAt;
    const time = formatRelativeTimestamp(timestamp) || timestamp;
    const exactTime = formatExactTimestamp(timestamp) || timestamp;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${fields.title}, ${fields.status}, #${item.channelName}, ${terminal ? exactTime : `started ${exactTime}`}${fields.costUsd > 0 ? `, ${formatCost(fields.costUsd)}` : ''}`}
        accessibilityHint="Long press for pin and archive actions"
        onPress={() => router.push(`/session/${item.id}`)}
        onLongPress={() => openRowActions(item)}
        style={({ pressed }) => ({
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
          backgroundColor: pressed ? colors.borderSoft : 'transparent',
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <StatusChip glance={listItemGlance(fields, item.live, Date.now())} />
          {fields.pinned && <Ionicons name="pin" size={13} color={colors.textMuted} accessibilityLabel="Pinned" />}
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
            gap: space.sm,
          }}
        >
          <Text style={{ flex: 1, color: colors.textMuted, fontSize: font.sm }} numberOfLines={1}>
            #{item.channelName}
          </Text>
          <Text style={{ color: colors.textFaint, fontSize: font.xs }}>{terminal ? time : `started ${time}`}</Text>
          {fields.costUsd > 0 && (
            <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>
              {formatCost(fields.costUsd)}
            </Text>
          )}
        </View>
      </Pressable>
    );
  };

  const archivedFooter = (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={archivedOpen ? 'Hide archived agents' : 'Show archived agents'}
        onPress={() => setArchivedOpen((open) => !open)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          minHeight: 44,
          borderTopWidth: 1,
          borderTopColor: colors.borderSoft,
        }}
      >
        <Ionicons name={archivedOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textMuted} />
        <Text
          style={{
            color: colors.textMuted,
            fontSize: font.xs,
            fontWeight: '700',
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          Archived
        </Text>
        {archived != null && <Text style={{ color: colors.textFaint, fontSize: font.xs }}>{archivedRows.length}</Text>}
      </Pressable>
      {archivedOpen &&
        (archivedLoading && archived == null ? (
          <View style={{ padding: space.lg }}>
            <ActivityIndicator color={colors.textMuted} />
          </View>
        ) : archivedRows.length === 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: font.sm, padding: space.lg }}>No archived agents.</Text>
        ) : (
          <View>
            {archivedRows.map((item) => (
              <View key={item.id}>{renderRow(item)}</View>
            ))}
          </View>
        ))}
      <View style={{ height: 96 }} />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader
        title="Agents"
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search agents"
            onPress={() => router.push('/session-search')}
            hitSlop={8}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Ionicons name="search-outline" size={21} color={colors.textSecondary} />
          </Pressable>
        }
      />
      <ConnectionBanner status={state.wsStatus} />
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => renderRow(item)}
          renderSectionHeader={({ section }) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: space.lg,
                paddingTop: 14,
                paddingBottom: 6,
                backgroundColor: colors.bg,
              }}
            >
              <Text
                style={{
                  color: colors.textMuted,
                  fontSize: font.xs,
                  fontWeight: '700',
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                }}
              >
                {section.title}
              </Text>
              <Text style={{ color: colors.textFaint, fontSize: font.xs }}>{section.data.length}</Text>
              {section.key === 'needs' && (
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.warning }} />
              )}
            </View>
          )}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                void load();
                if (archivedOpen) void loadArchived();
              }}
              tintColor={colors.textMuted}
            />
          }
          ListEmptyComponent={
            error ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Agents failed to load. Tap to retry."
                onPress={() => void load()}
                style={{ alignItems: 'center', justifyContent: 'center', padding: space.xl, minHeight: 44 }}
              >
                <Text style={{ color: colors.danger, fontSize: font.sm }}>Agents failed to load — tap to retry</Text>
              </Pressable>
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
                {/* First-run hero: sell the agent (the mobile analog of web's
                    "See an agent work / Run a demo agent" empty state). */}
                <View
                  style={{
                    width: '100%',
                    maxWidth: 340,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: colors.bgElevated,
                    borderRadius: radius.lg,
                    padding: space.lg,
                    alignItems: 'center',
                    gap: space.sm,
                  }}
                >
                  <Text
                    style={{
                      color: colors.accent,
                      fontSize: font.xs,
                      fontWeight: '700',
                      letterSpacing: 1,
                      textTransform: 'uppercase',
                    }}
                  >
                    First run
                  </Text>
                  <Text style={{ color: colors.text, fontSize: font.lg, fontWeight: '700' }}>See an agent work</Text>
                  <Text
                    style={{
                      color: colors.textSecondary,
                      fontSize: font.sm,
                      textAlign: 'center',
                      lineHeight: 20,
                    }}
                  >
                    An agent takes a task, runs tools, makes changes, and streams it all back to you live. Start one
                    from Chat, or run a 30-second demo.
                  </Text>
                  {hasChannels && (
                    <View style={{ width: '100%', alignItems: 'center', gap: space.sm, marginTop: space.xs }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Start an agent"
                        onPress={() => router.push('/')}
                        style={({ pressed }) => ({
                          backgroundColor: colors.accent,
                          opacity: pressed ? 0.85 : 1,
                          borderRadius: radius.md,
                          paddingVertical: 10,
                          paddingHorizontal: 18,
                          minHeight: 44,
                          justifyContent: 'center',
                        })}
                      >
                        <Text style={{ color: colors.onAccent, fontSize: font.sm, fontWeight: '700' }}>
                          Start an agent
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Run a demo agent"
                        onPress={() => {
                          const channelId = state.channels[0]?.id;
                          if (!channelId) return;
                          startDemoSession(channelId);
                          router.push(`/channel/${channelId}`);
                        }}
                        style={({ pressed }) => ({
                          borderWidth: 1,
                          borderColor: colors.border,
                          backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
                          borderRadius: radius.md,
                          paddingVertical: 10,
                          paddingHorizontal: 18,
                          minHeight: 44,
                          justifyContent: 'center',
                        })}
                      >
                        <Text style={{ color: colors.textSecondary, fontSize: font.sm, fontWeight: '700' }}>
                          Run a demo agent
                        </Text>
                      </Pressable>
                    </View>
                  )}
                  <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
                    You can also type !!&lt;task&gt; in any channel
                  </Text>
                </View>
              </View>
            )
          }
          contentContainerStyle={sections.length === 0 ? { flexGrow: 1 } : undefined}
          ListFooterComponent={archivedFooter}
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
