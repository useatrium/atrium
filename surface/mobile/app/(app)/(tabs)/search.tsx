// Message search (server-side FTS), modal. Tapping a result jumps to the
// message in its channel, paging history back until it's loaded.

import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { formatTime, type WireEvent } from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { font, radius, space, useTheme } from '../../../src/lib/theme';
import { MobileHeader } from '../../../src/components/MobileHeader';

interface Result {
  event: WireEvent;
  channelName: string;
}

export default function Search() {
  const { api, jumpToMessage } = useChat();
  const { colors } = useTheme();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setBusy(false);
      setError(false);
      return;
    }
    setBusy(true);
    setError(false);
    const mine = ++seq.current;
    const run = () => {
      api
        .search(query, 20)
        .then(({ results }) => {
          if (seq.current === mine) setResults(results);
        })
        .catch(() => {
          if (seq.current === mine) {
            setResults([]);
            setError(true);
          }
        })
        .finally(() => {
          if (seq.current === mine) setBusy(false);
        });
    };
    const t = setTimeout(() => {
      run();
    }, 250);
    return () => clearTimeout(t);
  }, [q, api]);

  const retry = () => {
    const query = q.trim();
    if (query.length < 2) return;
    setBusy(true);
    setError(false);
    const mine = ++seq.current;
    api
      .search(query, 20)
      .then(({ results }) => {
        if (seq.current === mine) setResults(results);
      })
      .catch(() => {
        if (seq.current === mine) {
          setResults([]);
          setError(true);
        }
      })
      .finally(() => {
        if (seq.current === mine) setBusy(false);
      });
  };

  const open = (r: Result) => {
    if (!r.event.channelId) return;
    router.dismiss();
    router.push(`/channel/${r.event.channelId}`);
    void jumpToMessage(r.event);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title="Search" />
      <View style={{ flex: 1, padding: space.lg, gap: space.md }}>
      <TextInput
        accessibilityLabel="Search messages"
        value={q}
        onChangeText={setQ}
        placeholder="Search messages"
        placeholderTextColor={colors.textFaint}
        autoFocus
        autoCorrect={false}
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
      {busy && <ActivityIndicator color={colors.textMuted} />}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.lg }}>
        {!busy && q.trim().length < 2 && (
          <Text style={{ color: colors.textMuted, fontSize: font.sm }}>
            Type at least 2 characters to search messages.
          </Text>
        )}
        {!busy && error && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search failed. Tap to retry."
            onPress={retry}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ color: colors.danger, fontSize: font.sm }}>Search failed — tap to retry</Text>
          </Pressable>
        )}
        {!busy && !error && q.trim().length >= 2 && results.length === 0 && (
          <Text style={{ color: colors.textMuted, fontSize: font.sm }}>No results.</Text>
        )}
        {results.map((r) => {
          const text = typeof r.event.payload?.text === 'string' ? r.event.payload.text : '';
          return (
            <Pressable
              key={r.event.id}
              accessibilityRole="button"
              accessibilityLabel={`#${r.channelName}, ${r.event.author?.displayName ?? 'Unknown'}, ${formatTime(r.event.createdAt)}: ${text}`}
              onPress={() => open(r)}
              style={({ pressed }) => ({
                paddingVertical: 10,
                paddingHorizontal: space.sm,
                borderRadius: radius.sm,
                backgroundColor: pressed ? colors.borderSoft : 'transparent',
              })}
            >
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 2 }}>
                <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>
                  #{r.channelName}
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
                  {r.event.author?.displayName ?? 'Unknown'}
                </Text>
                <Text style={{ color: colors.textFaint, fontSize: font.xs }}>
                  {formatTime(r.event.createdAt)}
                </Text>
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: font.sm }} numberOfLines={2}>
                {text}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      </View>
    </View>
  );
}
