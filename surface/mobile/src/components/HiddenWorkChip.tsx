import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { font, radius, space, useTheme } from '../lib/theme';

export interface WorkFoldStep {
  id: string;
  label: string;
  detail?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

const stepGlyph: Record<WorkFoldStep['status'], string> = {
  pending: '●',
  running: '✳',
  done: '✓',
  failed: '✕',
};

export function HiddenWorkChip({
  count,
  duration,
  steps = [],
  live = false,
  onShowFull,
}: {
  count: number;
  duration?: string;
  steps?: WorkFoldStep[];
  live?: boolean;
  onShowFull: () => void;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(live);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const noun = count === 1 ? 'step' : 'steps';

  // The live turn stays exposed while it streams, then folds itself when the
  // turn reaches a terminal state.
  useEffect(() => setExpanded(live), [live]);

  return (
    <View testID="work-fold" style={{ alignItems: 'flex-start', gap: space.xxs }}>
      <Pressable
        testID="hidden-work-chip"
        accessibilityRole="button"
        accessibilityLabel={`${count} work ${noun}${duration ? `, ${duration}` : ''}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ({
          minHeight: 44,
          justifyContent: 'center',
          borderRadius: radius.sm,
          paddingHorizontal: space.sm,
          backgroundColor: pressed ? colors.bgPressed : 'transparent',
        })}
      >
        <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
          {expanded ? '▼' : '▶'} ⚙ {count} {noun}
          {duration ? ` · ${duration}` : ''}
        </Text>
      </Pressable>
      {expanded && steps.length > 0 ? (
        <View style={{ width: '100%', borderLeftWidth: 1, borderLeftColor: colors.border, paddingLeft: space.sm }}>
          {steps.map((step) => {
            const detailOpen = expandedStep === step.id;
            return (
              <View key={step.id}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${step.label}, ${step.status}`}
                  accessibilityState={{ expanded: detailOpen }}
                  onPress={() => setExpandedStep((current) => (current === step.id ? null : step.id))}
                  style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.sm }}
                >
                  <Text
                    style={{
                      color:
                        step.status === 'failed'
                          ? colors.danger
                          : step.status === 'running'
                            ? colors.accent
                            : colors.textMuted,
                      fontFamily: 'monospace',
                      fontSize: font.xs,
                    }}
                  >
                    {stepGlyph[step.status]}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ flex: 1, color: colors.textSecondary, fontFamily: 'monospace', fontSize: font.xs }}
                  >
                    {step.label}
                  </Text>
                </Pressable>
                {detailOpen && step.detail ? (
                  <View style={{ gap: space.xxs, paddingBottom: space.sm }}>
                    <Text
                      numberOfLines={12}
                      style={{ color: colors.textMuted, fontFamily: 'monospace', fontSize: font.xs, lineHeight: 16 }}
                    >
                      {step.detail}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open full output for ${step.label}`}
                      onPress={onShowFull}
                      style={{ minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' }}
                    >
                      <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>full output →</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
      {expanded && steps.length === 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show full transcript"
          onPress={onShowFull}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm }}
        >
          <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>full output →</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
