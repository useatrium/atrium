import { Alert, Pressable, Text } from 'react-native';
import { router } from 'expo-router';
import { font, useTheme } from '../lib/theme';
import type { EntryReference, EntryReferenceSummary } from '../lib/entryReferences';

export function artifactEntryHandle(artifactId: string): string {
  return `art_${artifactId}`;
}

function referenceLabel(ref: EntryReference): string {
  const actor = ref.actorLabel?.trim() || 'Someone';
  const excerpt = ref.excerpt.replace(/\s+/g, ' ').trim();
  return excerpt ? `${actor}: ${excerpt}` : actor;
}

function openEntryReference(ref: EntryReference) {
  if (ref.threadRootEventId != null) {
    router.push({
      pathname: '/thread/[rootId]',
      params: { rootId: String(ref.threadRootEventId), channelId: ref.channelId },
    });
    return;
  }
  router.push(`/channel/${ref.channelId}`);
}

export function openEntryReferenceSummary(summary: EntryReferenceSummary | null) {
  const latest = summary?.latest ?? [];
  if (latest.length === 0) return;
  if (latest.length === 1) {
    openEntryReference(latest[0]!);
    return;
  }
  Alert.alert(
    'Discussed in',
    undefined,
    [
      ...latest.slice(0, 6).map((ref) => ({
        text: referenceLabel(ref),
        onPress: () => openEntryReference(ref),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ],
  );
}

export function EntryReferencesChip({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count} discussion reference${count === 1 ? '' : 's'}`}
      onPress={onPress}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
      })}
    >
      <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '900' }}>
        ↗ {count}
      </Text>
    </Pressable>
  );
}
