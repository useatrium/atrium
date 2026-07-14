import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';

/**
 * The agent's mark — a solid accent circle with an on-accent robot. Twin of
 * web's AgentMark: humans are rounded squares with initials; the agent is a
 * smaller solid circle. The only agent identity marker (no AGENT pill), so it
 * must read from 16px (meta lines) to 32px (headers). Uses the bundled
 * MaterialCommunityIcons robot glyph — no new native dependency.
 */
export function AgentMark({ size = 20, tone = 'accent' }: { size?: number; tone?: 'accent' | 'danger' }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: tone === 'danger' ? colors.danger : colors.accent,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <MaterialCommunityIcons name="robot" size={Math.round(size * 0.62)} color={colors.onAccent} />
    </View>
  );
}
