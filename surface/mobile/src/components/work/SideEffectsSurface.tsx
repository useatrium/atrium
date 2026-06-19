import { useMemo } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import type { SideEffect, SideEffectCategory, SideEffectRisk } from '@atrium/centaur-client';
import { font, radius, space, useTheme, type Colors } from '../../lib/theme';

const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const CATEGORY_ORDER: SideEffectCategory[] = ['network', 'package', 'git', 'filesystem', 'process', 'shell'];

function labelFor(category: SideEffectCategory): string {
  return category[0]!.toUpperCase() + category.slice(1);
}

function riskColor(risk: SideEffectRisk, colors: Colors): string {
  if (risk === 'danger') return colors.danger;
  if (risk === 'caution') return colors.warning;
  return colors.textMuted;
}

function EffectRow({ effect }: { effect: SideEffect }) {
  const { colors } = useTheme();
  const accent = riskColor(effect.risk, colors);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderTopWidth: 1,
        borderTopColor: colors.borderSoft,
      }}
    >
      <View
        style={{
          borderWidth: 1,
          borderColor: accent,
          borderRadius: radius.sm,
          paddingHorizontal: 6,
          paddingVertical: 2,
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
          {effect.risk}
        </Text>
      </View>
      <Text
        numberOfLines={1}
        ellipsizeMode="tail"
        style={{
          flex: 1,
          minWidth: 0,
          color: colors.text,
          fontFamily: monoFont,
          fontSize: font.xs,
          fontWeight: '600',
        }}
      >
        {effect.command}
      </Text>
    </View>
  );
}

export function SideEffectsSurface({ effects }: { effects: SideEffect[] }) {
  const { colors } = useTheme();
  const groups = useMemo(() => {
    const byCategory = new Map<SideEffectCategory, SideEffect[]>();
    for (const effect of effects) {
      const list = byCategory.get(effect.category);
      if (list) list.push(effect);
      else byCategory.set(effect.category, [effect]);
    }
    return CATEGORY_ORDER.map((category) => [category, byCategory.get(category) ?? []] as const).filter(
      ([, list]) => list.length > 0,
    );
  }, [effects]);

  if (groups.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
        <Text style={{ color: colors.textMuted, fontSize: font.sm }}>No side-effects.</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ paddingVertical: space.sm }}>
      {groups.map(([category, list]) => (
        <View
          key={category}
          style={{
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            backgroundColor: colors.bg,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: space.md,
              paddingVertical: space.xs,
              backgroundColor: colors.bgElevated,
            }}
          >
            <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
              {labelFor(category)}
            </Text>
            <Text style={{ color: colors.textFaint, fontSize: font.xs, fontVariant: ['tabular-nums'] }}>
              · {list.length}
            </Text>
          </View>
          {list.map((effect) => (
            <EffectRow key={effect.id} effect={effect} />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
