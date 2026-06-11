import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { UserRef } from '@atrium/surface-client';
import { useChat } from '../../src/lib/chat';
import { colors, font, space } from '../../src/lib/theme';
import { Avatar } from '../../src/components/Avatar';

export default function NewDm() {
  const { api, me, startDm } = useChat();
  const [users, setUsers] = useState<UserRef[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    api
      .users()
      .then(({ users }) => setUsers(users))
      .catch(() => setUsers([]));
  }, [api]);

  const open = async (u: UserRef) => {
    if (busyId) return;
    setBusyId(u.id);
    try {
      const channel = await startDm(u.id);
      router.dismiss();
      router.push(`/channel/${channel.id}`);
    } finally {
      setBusyId(null);
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
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }}>
      {users.map((u) => (
        <Pressable
          key={u.id}
          onPress={() => void open(u)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            paddingHorizontal: space.lg,
            paddingVertical: 10,
            backgroundColor: pressed ? colors.borderSoft : 'transparent',
            opacity: busyId && busyId !== u.id ? 0.5 : 1,
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
          {busyId === u.id && <ActivityIndicator size="small" color={colors.textMuted} />}
        </Pressable>
      ))}
    </ScrollView>
  );
}
