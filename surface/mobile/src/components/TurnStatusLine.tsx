import { useEffect, useRef, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  Text,
  View,
} from 'react-native';
import { formatTokens, type TurnLiveness, type TurnPhase } from '@atrium/centaur-client';
import { formatCost, formatElapsed } from '@atrium/surface-client';
import { font, space, useTheme } from '../lib/theme';

function HeartbeatDot({ pulse, parked }: { pulse: number; parked: boolean }) {
  const { colors, reduceMotion } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const lastBlipRef = useRef(Date.now());

  useEffect(() => {
    if (parked || reduceMotion) return;
    const nowMs = Date.now();
    if (nowMs - lastBlipRef.current < 250) return;
    lastBlipRef.current = nowMs;
    scale.setValue(1);
    opacity.setValue(1);
    Animated.parallel([
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.55, duration: 90, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 140, useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.45, duration: 90, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }),
      ]),
    ]).start();
  }, [opacity, parked, pulse, reduceMotion, scale]);

  return (
    <Animated.View
      testID="heartbeat-dot"
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        borderWidth: parked ? 1.5 : 0,
        borderColor: colors.textFaint,
        backgroundColor: parked ? 'transparent' : colors.accent,
        opacity,
        transform: [{ scale }],
      }}
    />
  );
}

export function TurnStatusLine({
  phase,
  liveness,
  label,
  elapsedMs,
  quietMs,
  pulse,
  tokens,
  costUsd,
  models,
  effort,
  cancelLabel,
  onCancel,
}: {
  phase: TurnPhase;
  liveness: TurnLiveness;
  label: string;
  elapsedMs: number;
  quietMs: number;
  pulse: number;
  tokens?: { count: number; estimated: boolean } | null;
  costUsd: number;
  models: string[];
  effort?: string | null;
  cancelLabel?: string;
  onCancel?: () => void;
}) {
  const { colors } = useTheme();
  const active = phase === 'thinking' || phase === 'tool';
  const showClock = elapsedMs >= 1000;
  const showMeta = Boolean(tokens) || costUsd > 0 || models.length > 0;
  const modelText = models.length > 0 ? `${models.join(', ')}${effort ? ` ${effort}` : ''}` : null;

  let left: ReactNode;
  if (!active) {
    left =
      phase === 'waiting' ? (
        <>
          <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '700' }}>
            {label}
          </Text>
          {quietMs >= 1000 ? (
            <Text style={{ color: colors.textFaint, fontSize: font.xs, fontVariant: ['tabular-nums'] }}>
              {formatElapsed(quietMs)}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '700' }}>
            ✓ {label}
          </Text>
          {showClock ? (
            <Text style={{ color: colors.textFaint, fontSize: font.xs, fontVariant: ['tabular-nums'] }}>
              {formatElapsed(elapsedMs)}
            </Text>
          ) : null}
        </>
      );
  } else if (liveness === 'reconnecting' || liveness === 'reattaching') {
    left = (
      <>
        <ActivityIndicator size="small" color={colors.warning} />
        <Text style={{ color: colors.warning, fontSize: font.xs, fontWeight: '800' }}>
          {liveness === 'reconnecting' ? 'Reconnecting…' : 'Reattaching to sandbox…'}
        </Text>
        {showClock ? (
          <Text style={{ color: colors.textFaint, fontSize: font.xs, fontVariant: ['tabular-nums'] }}>
            {formatElapsed(elapsedMs)}
          </Text>
        ) : null}
      </>
    );
  } else if (liveness === 'stuck') {
    left = (
      <>
        <HeartbeatDot pulse={pulse} parked />
        <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '700' }}>
          Still working? No output for {formatElapsed(quietMs)}
        </Text>
        {onCancel ? (
          <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={8}>
            <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '800' }}>
              {cancelLabel ?? 'Cancel'}
            </Text>
          </Pressable>
        ) : null}
        {showClock ? (
          <Text style={{ color: colors.textFaint, fontSize: font.xs, fontVariant: ['tabular-nums'] }}>
            {formatElapsed(elapsedMs)}
          </Text>
        ) : null}
      </>
    );
  } else if (liveness === 'quiet') {
    left = (
      <>
        <HeartbeatDot pulse={pulse} parked />
        <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '700' }}>
          {label}
        </Text>
        <Text style={{ color: colors.textFaint, fontSize: font.xs }}>
          — quiet for {formatElapsed(quietMs)}
        </Text>
        {showClock ? (
          <Text style={{ color: colors.textFaint, fontSize: font.xs, fontVariant: ['tabular-nums'] }}>
            {formatElapsed(elapsedMs)}
          </Text>
        ) : null}
      </>
    );
  } else {
    left = (
      <>
        <HeartbeatDot pulse={pulse} parked={false} />
        <Text
          numberOfLines={1}
          style={{ minWidth: 0, flexShrink: 1, color: colors.accent, fontSize: font.xs, fontWeight: '800' }}
        >
          {label}…
        </Text>
        {showClock ? (
          <Text style={{ color: colors.textFaint, fontSize: font.xs, fontVariant: ['tabular-nums'] }}>
            {formatElapsed(elapsedMs)}
          </Text>
        ) : null}
      </>
    );
  }

  return (
    <View
      testID="turn-status"
      style={{
        minHeight: 32,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingHorizontal: space.md,
        paddingVertical: 6,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
      }}
    >
      <View style={{ minWidth: 0, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        {left}
      </View>
      {showMeta ? (
        <View style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          {tokens ? (
            <Text
              testID="token-count"
              style={{ color: colors.textFaint, fontSize: font.xs, fontVariant: ['tabular-nums'] }}
            >
              {tokens.estimated ? '≈' : ''}
              {formatTokens(tokens.count)} tok
            </Text>
          ) : null}
          {tokens && (costUsd > 0 || modelText) ? (
            <Text style={{ color: colors.textFaint, fontSize: font.xs }}>·</Text>
          ) : null}
          {costUsd > 0 ? (
            <Text style={{ color: colors.textFaint, fontSize: font.xs, fontVariant: ['tabular-nums'] }}>
              {formatCost(costUsd)}
            </Text>
          ) : null}
          {costUsd > 0 && modelText ? (
            <Text style={{ color: colors.textFaint, fontSize: font.xs }}>·</Text>
          ) : null}
          {modelText ? (
            <Text numberOfLines={1} style={{ maxWidth: 140, color: colors.textFaint, fontSize: font.xs }}>
              {modelText}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
