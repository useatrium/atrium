import { Text, View } from 'react-native';
import {
  containsCriticMarkup,
  formatTurnTime,
  parseMarkupSteer,
  type SteerProvenance,
} from '@atrium/surface-client';
import { font, space, useTheme } from '../../lib/theme';
import { CriticMarkupText } from '../CriticMarkupText';
import { TimestampText } from '../TimestampText';
import { MarkupSteerCard } from './MarkupSteerCard';

export type SteerRowProvenance = {
  provenance: SteerProvenance;
  acceptedByMe: boolean;
};

function steerProvenanceText({ provenance, acceptedByMe }: SteerRowProvenance): string {
  const sentBy = acceptedByMe ? 'you' : provenance.resolvedByName;
  const parts = [`Proposed by ${provenance.proposerName}`, `sent by ${sentBy}`];
  if (provenance.edited) parts.push('edited');
  return parts.join(' · ');
}

function SteerProvenanceByline({ provenance }: { provenance?: SteerRowProvenance | null }) {
  const { colors } = useTheme();
  if (!provenance) return null;
  const label = steerProvenanceText(provenance);
  return (
    <View
      testID="steer-provenance"
      style={{
        marginTop: space.xs,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        flexWrap: 'wrap',
      }}
    >
      <Text
        accessibilityRole="image"
        accessibilityLabel={label}
        style={{ color: colors.textMuted, fontSize: font.xs, lineHeight: 16 }}
      >
        ↩
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: font.xs, lineHeight: 16 }}>
        {label}
      </Text>
    </View>
  );
}

/**
 * A user steer in the session transcript — a turn boundary. Mobile has no
 * hover, so the turn's wall-clock time renders always-visible but muted,
 * like iMessage's conversation-break timestamps. `ts` is absent on history
 * captured before the server stamped frames; the row then shows text only.
 */
export function SteerRow({
  text,
  ts,
  provenance,
}: {
  text: string;
  ts?: string;
  provenance?: SteerRowProvenance | null;
}) {
  const { colors } = useTheme();
  const time = ts ? formatTurnTime(ts) : '';
  const markupSteer = parseMarkupSteer(text);

  if (markupSteer || containsCriticMarkup(text)) {
    return (
      <View
        testID="steer-row"
        style={{ borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: space.sm }}
      >
        {time ? (
          <TimestampText
            iso={ts!}
            text={time}
            testID="steer-time"
            style={{ color: colors.textMuted, fontSize: font.xs, fontVariant: ['tabular-nums'] }}
          />
        ) : null}
        {markupSteer ? <MarkupSteerCard steer={markupSteer} /> : <CriticMarkupText text={text} />}
        <SteerProvenanceByline provenance={provenance} />
      </View>
    );
  }

  return (
    <View
      testID="steer-row"
      style={{ borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: space.sm }}
    >
      {time ? (
        <TimestampText
          iso={ts!}
          text={time}
          testID="steer-time"
          style={{ color: colors.textMuted, fontSize: font.xs, fontVariant: ['tabular-nums'] }}
        />
      ) : null}
      <Text style={{ color: colors.text, fontSize: font.sm }}>{text}</Text>
      <SteerProvenanceByline provenance={provenance} />
    </View>
  );
}
