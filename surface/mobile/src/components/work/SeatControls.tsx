import { Pressable, Text, View } from 'react-native';
import { font, radius, space, useTheme } from '../../lib/theme';

type SeatButtonTone = 'primary' | 'accent' | 'muted';

function SeatButton({
  label,
  accessibilityLabel,
  tone,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  tone: SeatButtonTone;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const isPrimary = tone === 'primary';
  const isAccent = tone === 'accent';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={space.xs}
      style={({ pressed }) => ({
        minHeight: 32,
        justifyContent: 'center',
        borderRadius: radius.sm,
        borderWidth: isPrimary ? 0 : 1,
        borderColor: isAccent ? colors.accent : colors.border,
        backgroundColor: isPrimary
          ? colors.accent
          : pressed
            ? isAccent
              ? colors.accentBg
              : colors.bgPressed
            : colors.bgElevated,
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        opacity: pressed && isPrimary ? 0.86 : 1,
      })}
    >
      <Text
        style={{
          color: isPrimary ? colors.onAccent : isAccent ? colors.accent : colors.textSecondary,
          fontSize: font.xs,
          fontWeight: '700',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function SeatRequestBanner({
  requesterName,
  onGrant,
  onIgnore,
}: {
  requesterName: string;
  onGrant: () => void;
  onIgnore: () => void;
}) {
  const { colors } = useTheme();

  return (
    <View
      testID="seat-request-banner"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.accent,
        backgroundColor: colors.accentBg,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          minWidth: 0,
          color: colors.text,
          fontSize: font.xs,
          fontWeight: '600',
        }}
      >
        {requesterName} requests the seat
      </Text>
      <SeatButton label="Grant" accessibilityLabel="Grant seat request" tone="primary" onPress={onGrant} />
      <SeatButton label="Ignore" accessibilityLabel="Ignore seat request" tone="muted" onPress={onIgnore} />
    </View>
  );
}

export function SeatFooter({
  mode,
  driverName,
  onRequest,
  onTake,
  onConfirmTake,
  onCancelTake,
}: {
  mode: 'request' | 'take' | 'confirm' | 'waiting';
  driverName: string;
  onRequest: () => void;
  onTake: () => void;
  onConfirmTake: () => void;
  onCancelTake: () => void;
}) {
  const { colors } = useTheme();

  return (
    <View
      testID="seat-footer"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.bg,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
      }}
    >
      {mode === 'request' ? (
        <SeatButton label="Request seat" accessibilityLabel="Request seat" tone="accent" onPress={onRequest} />
      ) : null}
      {mode === 'take' ? (
        <SeatButton label="Take seat" accessibilityLabel="Take seat" tone="accent" onPress={onTake} />
      ) : null}
      {mode === 'confirm' ? (
        <>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              minWidth: 0,
              color: colors.textSecondary,
              fontSize: font.xs,
              fontWeight: '600',
            }}
          >
            Take the seat from {driverName}?
          </Text>
          <SeatButton
            label="Confirm"
            accessibilityLabel={`Confirm taking the seat from ${driverName}`}
            tone="accent"
            onPress={onConfirmTake}
          />
          <SeatButton label="Keep watching" accessibilityLabel="Keep watching" tone="muted" onPress={onCancelTake} />
        </>
      ) : null}
      {mode === 'waiting' ? (
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '600' }}>
          Requested — waiting for {driverName}
        </Text>
      ) : null}
    </View>
  );
}
