import { Pressable, Text } from 'react-native';
import { font, space, useTheme } from '../lib/theme';

export function HiddenWorkChip({ count, onShowFull }: { count: number; onShowFull: () => void }) {
  const { colors } = useTheme();
  const steps = count === 1 ? 'step' : 'steps';
  return (
    <Pressable
      testID="hidden-work-chip"
      accessibilityRole="button"
      accessibilityLabel={`${count} hidden work ${steps}. Show full transcript`}
      onPress={onShowFull}
      style={{ alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: space.xs }}
    >
      <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
        ⚙ {count} work {steps}
      </Text>
    </Pressable>
  );
}
