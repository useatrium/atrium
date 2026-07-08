import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { destinationForEntry, firstRouteParam } from '../../../src/lib/deepLinkRoutes';
import { useChat } from '../../../src/lib/chat';
import { font, space, useTheme } from '../../../src/lib/theme';

export default function EntryResolverRoute() {
  const { handle: handleParam } = useLocalSearchParams<{ handle?: string }>();
  const handle = firstRouteParam(handleParam);
  const { resolveEntry } = useChat();
  const { colors } = useTheme();
  const [state, setState] = useState<'loading' | 'not-found'>('loading');

  useEffect(() => {
    if (!handle) {
      setState('not-found');
      return;
    }

    let disposed = false;
    setState('loading');
    void resolveEntry(handle)
      .then((entry) => {
        if (disposed) return;
        const destination = entry ? destinationForEntry(entry) : null;
        if (!destination) {
          setState('not-found');
          return;
        }
        router.replace(destination);
      })
      .catch(() => {
        if (!disposed) setState('not-found');
      });

    return () => {
      disposed = true;
    };
  }, [handle, resolveEntry]);

  if (state === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.md,
        padding: space.xl,
        backgroundColor: colors.bg,
      }}
    >
      <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700', textAlign: 'center' }}>
        Entry not found
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
        It may have been removed, or the link is not available.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go home"
        onPress={() => router.replace('/')}
        style={{
          minHeight: 44,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border,
          paddingHorizontal: space.lg,
        }}
      >
        <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '700' }}>Home</Text>
      </Pressable>
    </View>
  );
}
