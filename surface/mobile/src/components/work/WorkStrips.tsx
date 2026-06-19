// Summary strips (mobile) — the calm resting state of the work surfaces: a row
// of glanceable count chips above the composer. Tap one to open the full-screen
// surface (the "strip → tap" rung). Only non-empty surfaces show a chip.
import { Pressable, Text, View } from 'react-native';
import { font, radius, space, useTheme } from '../../lib/theme';

export interface WorkStripItem {
  key: string;
  label: string;
  count: number;
  danger?: boolean;
}

export function WorkStrips({
  items,
  onOpen,
}: {
  items: WorkStripItem[];
  onOpen: (key: string) => void;
}) {
  const { colors } = useTheme();
  const shown = items.filter((i) => i.count > 0);
  if (shown.length === 0) return null;

  return (
    <View
      style={{
        flexDirection: 'row',
        gap: space.sm,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      {shown.map((item) => (
        <Pressable
          key={item.key}
          onPress={() => onOpen(item.key)}
          accessibilityRole="button"
          accessibilityLabel={`${item.label}: ${item.count}`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.bgElevated,
            borderRadius: radius.sm,
            paddingHorizontal: space.sm,
            paddingVertical: 5,
          }}
        >
          <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '700' }}>
            {item.label}
          </Text>
          <Text style={{ color: item.danger ? colors.danger : colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>
            {item.count}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
