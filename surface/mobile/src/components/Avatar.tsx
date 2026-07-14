import { Text, View } from 'react-native';
import { initials, userColorTokens } from '@atrium/surface-client';
import { useTheme } from '../lib/theme';
import { AgentMark } from './AgentMark';

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
  const { scheme } = useTheme();
  const userColors = userColorTokens(seed, scheme);
  if (variant === 'agent') {
    // Same footprint as the human square so gutters align; the mark itself is
    // a smaller solid circle so it never reads as a person.
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      >
        <AgentMark size={Math.max(16, Math.round(size * 0.75))} />
      </View>
    );
  }
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
