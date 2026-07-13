import { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import type { FileChange } from '@atrium/centaur-client';
import { font, radius, space, useTheme } from '../../lib/theme';
import { DiffView, KIND_LABEL, diffStats, kindColor } from './fileChangeView';

const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function FileRow({ path, changes }: { path: string; changes: FileChange[] }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const kind = changes[changes.length - 1]!.kind;
  const diff = changes
    .map((change) => change.diff)
    .filter(Boolean)
    .join('\n');
  const { adds, dels } = diffStats(diff);
  const accent = kindColor(kind, colors);

  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.bg,
      }}
    >
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${KIND_LABEL[kind]} ${path}`}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          backgroundColor: pressed ? colors.bgPressed : colors.bg,
        })}
      >
        <View
          style={{
            borderWidth: 1,
            borderColor: accent,
            borderRadius: radius.sm,
            paddingHorizontal: 6,
            paddingVertical: space.xxs,
            backgroundColor: colors.bgElevated,
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
            {KIND_LABEL[kind]}
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
          {path}
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
      </Pressable>
      {open && diff ? <DiffView diff={diff} /> : null}
    </View>
  );
}

export function ChangesSurface({ changes }: { changes: FileChange[] }) {
  const { colors } = useTheme();
  const groups = useMemo(() => {
    const byPath = new Map<string, FileChange[]>();
    for (const change of changes) {
      const list = byPath.get(change.path);
      if (list) list.push(change);
      else byPath.set(change.path, [change]);
    }
    return [...byPath.entries()];
  }, [changes]);

  if (groups.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
        <Text style={{ color: colors.textMuted, fontSize: font.sm }}>No file changes.</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ paddingVertical: space.sm }}>
      {groups.map(([path, fileChanges]) => (
        <FileRow key={path} path={path} changes={fileChanges} />
      ))}
    </ScrollView>
  );
}
