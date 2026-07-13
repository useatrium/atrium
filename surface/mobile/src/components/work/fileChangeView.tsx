import { useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import type { FileChange, FileChangeKind } from '@atrium/centaur-client';
import { font, radius, space, useTheme, type Colors } from '../../lib/theme';

const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const KIND_LABEL: Record<FileChangeKind, string> = {
  add: 'added',
  update: 'edited',
  delete: 'deleted',
};

export function kindColor(kind: FileChangeKind, colors: Colors): string {
  if (kind === 'add') return colors.online;
  if (kind === 'delete') return colors.danger;
  return colors.textSecondary;
}

export function diffStats(diff: string): { adds: number; dels: number } {
  if (!diff) return { adds: 0, dels: 0 };
  const lines = diff.split('\n');
  return {
    adds: lines.filter((line) => line.startsWith('+')).length,
    dels: lines.filter((line) => line.startsWith('-')).length,
  };
}

export function DiffView({ diff }: { diff: string }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      style={{
        maxHeight: 288,
        backgroundColor: colors.bgInput,
        borderTopWidth: 1,
        borderTopColor: colors.borderSoft,
      }}
      contentContainerStyle={{
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
      }}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      {diff.split('\n').map((line, index) => {
        const color = line.startsWith('+') ? colors.online : line.startsWith('-') ? colors.danger : colors.textMuted;
        return (
          <Text
            key={`${index}:${line}`}
            style={{
              color,
              fontFamily: monoFont,
              fontSize: font.xs,
              lineHeight: 16,
            }}
          >
            {line || ' '}
          </Text>
        );
      })}
    </ScrollView>
  );
}

export function InlineFileChange({
  change,
  status = 'done',
  onLongPress,
}: {
  change: FileChange;
  status?: 'running' | 'error' | 'done';
  onLongPress?: () => void;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const { adds, dels } = diffStats(change.diff);
  const accent = kindColor(change.kind, colors);

  return (
    <View
      testID="inline-file-change"
      style={{
        borderWidth: 1,
        borderColor: status === 'error' ? colors.dangerBorder : colors.border,
        backgroundColor: status === 'error' ? colors.dangerSurface : colors.bgElevated,
        borderRadius: radius.sm,
        overflow: 'hidden',
      }}
    >
      <Pressable
        onPress={() => setOpen((value) => !value)}
        onLongPress={onLongPress}
        delayLongPress={250}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={
          onLongPress
            ? `Message actions: ${KIND_LABEL[change.kind]} ${change.path}`
            : `${KIND_LABEL[change.kind]} ${change.path}`
        }
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.sm,
          paddingVertical: space.sm,
          backgroundColor: pressed ? colors.bgPressed : 'transparent',
        })}
      >
        <Text style={{ color: colors.textMuted, fontSize: font.xs, width: 10 }}>{open ? '▾' : '▸'}</Text>
        <View
          style={{
            borderWidth: 1,
            borderColor: accent,
            borderRadius: radius.sm,
            paddingHorizontal: 6,
            paddingVertical: space.xxs,
            backgroundColor: colors.bg,
          }}
        >
          <Text
            style={{
              color: accent,
              fontSize: font.xs,
              fontWeight: '800',
              textTransform: 'uppercase',
            }}
          >
            {KIND_LABEL[change.kind]}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          ellipsizeMode="middle"
          style={{
            flex: 1,
            minWidth: 0,
            color: colors.text,
            fontFamily: monoFont,
            fontSize: font.xs,
            fontWeight: '600',
          }}
        >
          {change.path}
        </Text>
        {adds > 0 ? (
          <Text style={{ color: colors.online, fontSize: font.xs, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
            +{adds}
          </Text>
        ) : null}
        {dels > 0 ? (
          <Text style={{ color: colors.danger, fontSize: font.xs, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
            −{dels}
          </Text>
        ) : null}
        {status === 'running' ? (
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
        ) : (
          <Text
            style={{
              color: status === 'error' ? colors.danger : colors.textMuted,
              fontSize: font.xs,
              fontWeight: '700',
            }}
          >
            {status === 'error' ? 'ERROR' : 'DONE'}
          </Text>
        )}
      </Pressable>
      {open && change.diff ? <DiffView diff={change.diff} /> : null}
    </View>
  );
}
