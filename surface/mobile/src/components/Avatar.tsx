import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { initials, userColorTokens } from '@atrium/surface-client';
import { useTheme } from '../lib/theme';

/** Colored-initials avatar, same hash/palette as the web client. */
export function Avatar({
  name,
  seed,
  size = 36,
  variant = 'human',
}: {
  name: string;
  seed: string;
  size?: number;
  variant?: 'human' | 'agent';
}) {
  const { colors, scheme } = useTheme();
  const userColors = userColorTokens(seed, scheme);
  const isAgent = variant === 'agent';
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: isAgent ? colors.accentBg : userColors.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {isAgent ? (
        <Ionicons name="hardware-chip-outline" size={Math.round(size * 0.52)} color={colors.accent} />
      ) : (
        <Text
          style={{
            color: userColors.fg,
            fontSize: Math.round(size * 0.38),
            fontWeight: '700',
          }}
        >
          {initials(name)}
        </Text>
      )}
    </View>
  );
}
