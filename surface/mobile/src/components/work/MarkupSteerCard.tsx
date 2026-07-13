import { Text, View } from 'react-native';
import { parseCriticMarkup, type ParsedMarkupSteer } from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../../lib/theme';
import { CriticMarkupBlocks, NoteRow } from '../CriticMarkupText';

export function MarkupSteerCard({ steer }: { steer: ParsedMarkupSteer }) {
  const { colors } = useTheme();
  const title = steer.intent === 'revise' ? (steer.path ?? 'document') : `"${steer.title ?? 'message'}"`;
  const badge = steer.intent === 'revise' ? 'Revise' : 'Response';

  return (
    <View
      testID="markup-steer-card"
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
        <Text style={{ flex: 1, color: colors.text, fontSize: font.sm, fontWeight: '800' }}>Marked up {title}</Text>
        <Text
          style={{
            color: colors.accent,
            backgroundColor: colors.accentBg,
            borderRadius: radius.sm,
            overflow: 'hidden',
            paddingHorizontal: space.sm,
            paddingVertical: space.xxs,
            fontSize: font.xs,
            fontWeight: '800',
          }}
        >
          {badge}
        </Text>
      </View>

      <CriticMarkupBlocks blocks={parseCriticMarkup(steer.doc)} />

      {steer.note ? <NoteRow text={steer.note} /> : null}
      {steer.truncated ? (
        <Text style={{ color: colors.textMuted, fontSize: font.xs, lineHeight: 16 }}>
          Excerpt only. The full marked-up document is already synced into the workspace.
        </Text>
      ) : null}
      {steer.conflict ? (
        <NoteRow
          label="Conflict"
          text="A newer version exists. Inspect the file conflict before producing a clean revision."
          warning
        />
      ) : null}
    </View>
  );
}
