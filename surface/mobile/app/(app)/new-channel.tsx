import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ApiError } from '@atrium/surface-client';
import { useChat } from '../../src/lib/chat';
import { colors, font, radius, space } from '../../src/lib/theme';

export default function NewChannel() {
  const { createChannel } = useChat();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = name.trim().length > 0 && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const channel = await createChannel(name.trim());
      router.dismiss();
      router.push(`/channel/${channel.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the channel.');
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, padding: space.lg, gap: space.md }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: colors.bgInput,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.md,
          paddingHorizontal: space.md,
        }}
      >
        <Text style={{ color: colors.textMuted, fontSize: font.md, marginRight: 4 }}>#</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="channel-name"
          placeholderTextColor={colors.textFaint}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => void create()}
          style={{ flex: 1, color: colors.text, fontSize: font.md, paddingVertical: 12 }}
        />
      </View>
      <Text style={{ color: colors.textFaint, fontSize: font.xs }}>
        Lowercase letters, digits, dashes and underscores.
      </Text>
      {error && <Text style={{ color: colors.danger, fontSize: font.sm }}>{error}</Text>}
      <Pressable
        onPress={() => void create()}
        disabled={!canCreate}
        style={{
          backgroundColor: canCreate ? colors.accent : colors.bgElevated,
          borderRadius: radius.md,
          alignItems: 'center',
          paddingVertical: 13,
        }}
      >
        {busy ? (
          <ActivityIndicator color={colors.bg} />
        ) : (
          <Text
            style={{
              color: canCreate ? colors.bg : colors.textFaint,
              fontSize: font.md,
              fontWeight: '700',
            }}
          >
            Create channel
          </Text>
        )}
      </Pressable>
    </View>
  );
}
