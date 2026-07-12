import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { formatTime, type Api } from '@atrium/surface-client';
import { useChat } from '../lib/chat';
import { font, radius, space, useTheme } from '../lib/theme';

const MIN_QUERY_LENGTH = 2;
const SEARCH_DELAY_MS = 250;
const SEARCH_LIMIT = 20;

type SearchSessionsResponse = Awaited<ReturnType<Api['searchSessions']>>;
type SessionRecordHit = SearchSessionsResponse['results'][number];

type SessionSearchItem =
  | {
      kind: 'header';
      key: string;
      sessionId: string;
      title: string;
      channelName: string | null;
    }
  | {
      kind: 'hit';
      key: string;
      hit: SessionRecordHit;
    };

function actorLabel(actor: SessionRecordHit['actor']): string {
  if (actor === 'agent') return 'Agent';
  if (actor === 'system') return 'System';
  return 'User';
}

function driverLabel(driver: SessionRecordHit['driver']): string | null {
  if (driver === 'claude') return 'Claude';
  if (driver === 'codex') return 'Codex';
  return null;
}

function actorDriverLabel(hit: SessionRecordHit): string {
  const driver = driverLabel(hit.driver);
  return driver ? `${actorLabel(hit.actor)} · ${driver}` : actorLabel(hit.actor);
}

function kindLabel(kind: SessionRecordHit['kind']): string {
  return kind.replace(/_/g, ' ').toUpperCase();
}

function titleFor(hit: SessionRecordHit): string {
  const title = hit.sessionTitle?.trim();
  return title || hit.sessionId;
}

function buildItems(results: SessionRecordHit[]): SessionSearchItem[] {
  const groups: Array<{
    sessionId: string;
    title: string;
    channelName: string | null;
    hits: SessionRecordHit[];
  }> = [];
  const bySession = new Map<string, (typeof groups)[number]>();

  for (const hit of results) {
    let group = bySession.get(hit.sessionId);
    if (!group) {
      group = {
        sessionId: hit.sessionId,
        title: titleFor(hit),
        channelName: hit.channelName,
        hits: [],
      };
      bySession.set(hit.sessionId, group);
      groups.push(group);
    }
    group.hits.push(hit);
  }

  const items: SessionSearchItem[] = [];
  let hitIndex = 0;
  for (const group of groups) {
    items.push({
      kind: 'header',
      key: `header:${group.sessionId}`,
      sessionId: group.sessionId,
      title: group.title,
      channelName: group.channelName,
    });
    for (const hit of group.hits) {
      items.push({
        kind: 'hit',
        key: `hit:${hit.sessionId}:${hit.ts}:${hit.kind}:${hitIndex}`,
        hit,
      });
      hitIndex += 1;
    }
  }
  return items;
}

export function SessionSearch() {
  const { api } = useChat();
  const { colors } = useTheme();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SessionRecordHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const search = useCallback(
    (query: string, delayMs = 0) => {
      const mine = ++seq.current;
      setResults([]);
      setBusy(true);
      setError(null);
      const execute = () => {
        api
          .searchSessions({ q: query, limit: SEARCH_LIMIT })
          .then(({ results }) => {
            if (seq.current === mine) setResults(results);
          })
          .catch((err: unknown) => {
            if (seq.current === mine) {
              setResults([]);
              setError(err instanceof Error ? err.message : 'Search failed');
            }
          })
          .finally(() => {
            if (seq.current === mine) setBusy(false);
          });
      };
      const timer = delayMs > 0 ? setTimeout(execute, delayMs) : null;
      if (timer == null) execute();
      return () => {
        if (timer != null) clearTimeout(timer);
        if (seq.current === mine) seq.current += 1;
      };
    },
    [api],
  );

  useEffect(() => {
    const query = q.trim();
    if (query.length < MIN_QUERY_LENGTH) {
      seq.current += 1;
      setResults([]);
      setBusy(false);
      setError(null);
      return;
    }
    return search(query, SEARCH_DELAY_MS);
  }, [q, search]);

  const retry = useCallback(() => {
    const query = q.trim();
    if (query.length < MIN_QUERY_LENGTH) return;
    search(query);
  }, [q, search]);

  const items = useMemo(() => buildItems(results), [results]);
  const queryReady = q.trim().length >= MIN_QUERY_LENGTH;

  const open = useCallback((hit: SessionRecordHit) => {
    router.dismiss();
    router.push(`/session/${hit.sessionId}`);
  }, []);

  const empty = () => {
    if (busy) {
      return (
        <View style={{ paddingTop: space.md }}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      );
    }
    if (!queryReady) {
      return (
        <Text style={{ color: colors.textMuted, fontSize: font.sm }}>
          Type at least 2 characters to search sessions.
        </Text>
      );
    }
    if (error) {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Session search failed. Tap to retry."
          onPress={retry}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={{ color: colors.danger, fontSize: font.sm }}>Session search failed — tap to retry</Text>
        </Pressable>
      );
    }
    return <Text style={{ color: colors.textMuted, fontSize: font.sm }}>No results.</Text>;
  };

  const renderItem = ({ item }: { item: SessionSearchItem }) => {
    if (item.kind === 'header') {
      return (
        <View
          accessibilityRole="header"
          style={{
            paddingHorizontal: space.lg,
            paddingTop: space.lg,
            paddingBottom: space.sm,
            gap: 2,
          }}
        >
          <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '800' }} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
            {item.channelName ? `#${item.channelName}` : item.sessionId}
          </Text>
        </View>
      );
    }

    const hit = item.hit;
    const excerpt = hit.excerpt.trim() || 'No excerpt';
    const meta = actorDriverLabel(hit);
    const time = formatTime(hit.ts);
    const sessionTitle = titleFor(hit);
    const channel = hit.channelName ? `#${hit.channelName}` : 'No channel';
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${sessionTitle}, ${channel}, ${kindLabel(hit.kind)}, ${meta}, ${time}: ${excerpt}`}
        onPress={() => open(hit)}
        style={({ pressed }) => ({
          paddingHorizontal: space.lg,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSoft,
          backgroundColor: pressed ? colors.borderSoft : 'transparent',
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <View
            style={{
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 999,
              backgroundColor: colors.bgElevated,
              paddingHorizontal: 8,
              paddingVertical: 3,
            }}
          >
            <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '800' }}>{kindLabel(hit.kind)}</Text>
          </View>
          <Text style={{ flex: 1, minWidth: 0, color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
            {meta}
          </Text>
          <Text style={{ color: colors.textFaint, fontSize: font.xs }}>{time}</Text>
        </View>
        <Text
          style={{
            color: colors.textSecondary,
            fontSize: font.sm,
            lineHeight: 19,
            marginTop: 6,
          }}
          numberOfLines={3}
        >
          {excerpt}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: space.lg, paddingBottom: space.sm }}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search agents"
          placeholderTextColor={colors.textFaint}
          accessibilityLabel="Search agents"
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={{
            backgroundColor: colors.bgInput,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
            color: colors.text,
            fontSize: font.md,
            paddingHorizontal: space.md,
            paddingVertical: 10,
          }}
        />
      </View>
      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={empty}
        ListFooterComponent={items.length > 0 ? <View style={{ height: space.xl }} /> : null}
        contentContainerStyle={items.length === 0 ? { paddingHorizontal: space.lg } : undefined}
      />
    </View>
  );
}
