import { Pressable, Text, View } from 'react-native';
import { font, radius, space, useTheme } from '../lib/theme';

export type AgentModeTarget = 'steer' | 'new';
export type AgentEffort = 'low' | 'medium' | 'high' | 'max';

function Option({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        borderColor: selected ? colors.accent : colors.border,
        borderRadius: radius.sm,
        borderWidth: 1,
        backgroundColor: pressed ? colors.bgPressed : selected ? colors.accentBg : colors.bgInput,
        minHeight: 42,
        justifyContent: 'center',
        paddingHorizontal: space.sm,
      })}
    >
      <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: selected ? '800' : '500' }}>{label}</Text>
    </Pressable>
  );
}

export function AgentModeConfig({
  sessionTitle,
  isDriver,
  target,
  effort,
  anchorLabel,
  onTarget,
  onEffort,
  onClearAnchor,
}: {
  sessionTitle?: string | null;
  isDriver: boolean;
  target: AgentModeTarget;
  effort: AgentEffort;
  anchorLabel?: string | null;
  onTarget: (target: AgentModeTarget) => void;
  onEffort: (effort: AgentEffort) => void;
  onClearAnchor: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View testID="agent-mode-config" style={{ gap: space.md }}>
      <View style={{ gap: space.xs }}>
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>TARGET</Text>
        {sessionTitle ? (
          <View accessibilityRole="radiogroup" style={{ gap: space.xs }}>
            <Option
              label={`${isDriver ? 'Steer' : 'Suggest'} · “${sessionTitle}”`}
              selected={target === 'steer'}
              onPress={() => onTarget('steer')}
            />
            <Option label="New session in this thread" selected={target === 'new'} onPress={() => onTarget('new')} />
          </View>
        ) : (
          <Text style={{ color: colors.textSecondary, fontSize: font.sm }}>New agent in this channel</Text>
        )}
      </View>
      <View style={{ gap: space.xs }}>
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>EFFORT</Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          {(['low', 'medium', 'high', 'max'] as const).map((value) => (
            <Option key={value} label={value} selected={effort === value} onPress={() => onEffort(value)} />
          ))}
        </View>
      </View>
      <Text style={{ color: colors.textMuted, fontSize: font.xs, lineHeight: 16 }}>
        The agent reads this conversation before starting (⚓ anchor).
      </Text>
      {anchorLabel ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text numberOfLines={1} style={{ color: colors.textSecondary, flex: 1, fontSize: font.sm }}>
            ⚓ {anchorLabel}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear agent anchor"
            onPress={onClearAnchor}
            hitSlop={8}
          >
            <Text style={{ color: colors.accent, fontSize: font.sm, fontWeight: '700' }}>Clear</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
