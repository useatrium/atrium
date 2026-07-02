import { Text, View } from 'react-native';
import { formatTurnTime } from '@atrium/surface-client';
import { font, space, useTheme } from '../../lib/theme';

/**
 * A user steer in the session transcript — a turn boundary. Mobile has no
 * hover, so the turn's wall-clock time renders always-visible but muted,
 * like iMessage's conversation-break timestamps. `ts` is absent on history
 * captured before the server stamped frames; the row then shows text only.
 */
export function SteerRow({ text, ts }: { text: string; ts?: string }) {
  const { colors } = useTheme();
  const time = ts ? formatTurnTime(ts) : '';

  return (
    <View
      testID="steer-row"
      style={{ borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: space.sm }}
    >
      {time ? (
        <Text
          testID="steer-time"
          style={{ color: colors.textMuted, fontSize: font.xs, fontVariant: ['tabular-nums'] }}
        >
          {time}
        </Text>
      ) : null}
      <Text style={{ color: colors.text, fontSize: font.sm }}>{text}</Text>
    </View>
  );
}
