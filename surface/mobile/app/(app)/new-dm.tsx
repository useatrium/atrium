import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { UserRef } from '@atrium/surface-client';
import { useChat } from '../../src/lib/chat';
import { font, space, useTheme } from '../../src/lib/theme';
import { Avatar } from '../../src/components/Avatar';

export default function NewDm() {
  const { api, me, startDm } = useChat();
  const { colors } = useTheme();
  const [users, setUsers] = useState<UserRef[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    api
      .users()
      .then(({ users }) => setUsers(users))
      .catch(() => setUsers([]));
  }, [api]);

  const start = async () => {
    if (busy || selected.size === 0) return;
    setBusy(true);
    try {
      const channel = await startDm([...selected]);
      router.dismiss();
      router.push(`/channel/${channel.id}`);
    } catch {
      Alert.alert('Error', "Couldn't start the conversation — try again.");
    } finally {
      setBusy(false);
    }
  };

  if (users === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
    <ScrollView style={{ flex: 1 }}>
      {users.map((u) => (
        <Pressable
          key={u.id}
          accessibilityRole="checkbox"
          accessibilityLabel={`${u.displayName}, @${u.handle}${u.id === me.id ? ', you' : ''}`}
          accessibilityState={{ selected: selected.has(u.id), checked: selected.has(u.id), disabled: busy }}
          onPress={() =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(u.id)) next.delete(u.id);
              else next.add(u.id);
              return next;
            })
          }
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            paddingHorizontal: space.lg,
            paddingVertical: 10,
            backgroundColor: pressed ? colors.borderSoft : 'transparent',
            opacity: busy ? 0.5 : 1,
          })}
        >
          <Avatar name={u.displayName} seed={u.id} size={32} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '600' }}>
              {u.displayName}
              {u.id === me.id ? '  (you)' : ''}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: font.xs }}>@{u.handle}</Text>
          </View>
          {selected.has(u.id) && <Text style={{ color: colors.accent, fontSize: font.lg }}>✓</Text>}
        </Pressable>
      ))}
    </ScrollView>
    {selected.size > 0 && (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Start ${selected.size > 1 ? 'group DM' : 'DM'}`}
        accessibilityState={{ disabled: busy }}
        onPress={() => void start()}
        disabled={busy}
        style={{
          margin: space.lg,
          alignItems: 'center',
          paddingVertical: 13,
          borderRadius: 10,
          backgroundColor: colors.accent,
        }}
      >
        {busy ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={{ color: colors.onAccent, fontSize: font.md, fontWeight: '700' }}>
            Start {selected.size > 1 ? 'group DM' : 'DM'}
          </Text>
        )}
      </Pressable>
    )}
    </View>
  );
}
