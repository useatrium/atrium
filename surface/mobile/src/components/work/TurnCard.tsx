import { Text, View } from 'react-native';
import { formatCost } from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../../lib/theme';

export interface TurnCardProps {
  status: string;
  resultText?: string | null;
  costUsd?: number | null;
}

function displayCost(costUsd: number | null | undefined): string | null {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd <= 0) return null;
  return formatCost(costUsd);
}

export function TurnCard({ status, resultText, costUsd }: TurnCardProps) {
  const { colors } = useTheme();
  const result = (resultText ?? '').trim();
  const cost = displayCost(costUsd);

  if (!result && !cost) return null;

  return (
    <View
      testID="turn-card"
      accessibilityLabel={`Turn ${status || 'idle'} summary`}
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        backgroundColor: colors.bgElevated,
        padding: space.md,
        gap: space.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
          RESULT
        </Text>
        {cost ? (
          <Text
            style={{
              marginLeft: 'auto',
              color: colors.textMuted,
              fontSize: font.xs,
              fontVariant: ['tabular-nums'],
            }}
          >
            {cost}
          </Text>
        ) : null}
      </View>
      {result ? (
        <Text style={{ color: colors.text, fontSize: font.sm, lineHeight: 20 }}>
          {result}
        </Text>
      ) : null}
    </View>
  );
}
