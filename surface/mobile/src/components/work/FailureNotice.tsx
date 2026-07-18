import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { FailureInfo } from '@atrium/centaur-client';
import { font, radius, space, useTheme } from '../../lib/theme';

export interface FailureNoticeProps {
  info: FailureInfo;
}

export function FailureNotice({ info }: FailureNoticeProps) {
  const { colors } = useTheme();
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <View
      testID="failure-notice"
      accessibilityLabel={`${info.label}: ${info.summary}`}
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        backgroundColor: colors.bgElevated,
        padding: space.md,
        gap: space.sm,
      }}
    >
      <Text style={{ color: colors.danger, fontSize: font.xs, fontWeight: '800' }}>{info.label}</Text>
      <Text style={{ color: colors.text, fontSize: font.sm, lineHeight: 20 }}>{info.summary}</Text>
      {info.detail ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={detailsOpen ? 'Hide failure details' : 'Show failure details'}
            accessibilityState={{ expanded: detailsOpen }}
            onPress={() => setDetailsOpen((open) => !open)}
            style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.7 : 1 })}
          >
            <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '700' }}>
              {detailsOpen ? 'Hide details' : 'Details'}
            </Text>
          </Pressable>
          {detailsOpen ? <Text style={{ color: colors.textMuted, fontSize: font.xs }}>{info.detail}</Text> : null}
        </>
      ) : null}
    </View>
  );
}
