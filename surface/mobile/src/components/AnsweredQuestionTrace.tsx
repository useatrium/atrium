import { Text, View } from 'react-native';
import { formatRelativeTimestamp, type SessionAnsweredQuestion } from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../lib/theme';

/**
 * The durable record an agent question leaves behind once it resolves: who
 * answered, what they picked, when. Mirrors the web `AnsweredQuestionTrace` so
 * "who approved the 2am run" reads the same on every surface.
 */
export function AnsweredQuestionTrace({ trace }: { trace: SessionAnsweredQuestion }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel={`Answered by ${trace.answeredByName}: ${trace.answerText}`}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 4,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.sm,
        paddingHorizontal: space.sm,
        paddingVertical: 6,
      }}
    >
      <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '900' }}>✓</Text>
      <Text style={{ color: colors.textSecondary, fontSize: font.xs }}>Answered by</Text>
      <Text style={{ color: colors.text, fontSize: font.xs, fontWeight: '800' }}>{trace.answeredByName}</Text>
      <Text style={{ color: colors.textMuted, fontSize: font.xs }}>·</Text>
      <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '700', flexShrink: 1 }}>
        {trace.answerText}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: font.xs }}>·</Text>
      <Text style={{ color: colors.textMuted, fontSize: font.xs }}>{formatRelativeTimestamp(trace.at)}</Text>
    </View>
  );
}
