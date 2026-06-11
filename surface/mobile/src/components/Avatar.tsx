import { Text, View } from 'react-native';
import { initials, userColorTokens } from '@atrium/surface-client';
import { useTheme } from '../lib/theme';

/** Colored-initials avatar, same hash/palette as the web client. */
export function Avatar({ name, seed, size = 36 }: { name: string; seed: string; size?: number }) {
  const { scheme } = useTheme();
  const userColors = userColorTokens(seed, scheme);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: userColors.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: userColors.fg,
          fontSize: Math.round(size * 0.38),
          fontWeight: '700',
        }}
      >
        {initials(name)}
      </Text>
    </View>
  );
}
