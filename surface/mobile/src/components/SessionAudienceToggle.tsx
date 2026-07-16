import { Pressable, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { radius, space, useTheme } from '../lib/theme';

export type SessionComposerAudience = 'people' | 'agent';
export type SessionComposerRoute = 'discussion' | 'steer' | 'suggest';

export function sessionComposerRoute(
  audience: SessionComposerAudience,
  isDriver: boolean,
  discussionAvailable: boolean,
): SessionComposerRoute {
  if (audience === 'people' && discussionAvailable) return 'discussion';
  return isDriver ? 'steer' : 'suggest';
}

export function AudienceSwitch({
  audience,
  onToggle,
  disabled = false,
  accessibilityHint,
  testID,
}: {
  audience: SessionComposerAudience;
  onToggle: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
  testID?: string;
}) {
  const { colors } = useTheme();
  const agentMode = audience === 'agent';

  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel="Agent audience"
      accessibilityHint={accessibilityHint ?? 'On prompts the agent. Off messages people.'}
      accessibilityState={{ checked: agentMode, disabled }}
      accessibilityValue={{ text: agentMode ? 'Agent' : 'People' }}
      aria-checked={agentMode}
      disabled={disabled}
      hitSlop={space.xs}
      onPress={onToggle}
      style={({ pressed }) => ({
        alignItems: 'center',
        height: 40,
        justifyContent: 'center',
        opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
        width: 72,
      })}
    >
      <View
        style={{
          alignItems: 'center',
          backgroundColor: colors.bgElevated,
          borderColor: colors.border,
          borderRadius: radius.md,
          borderWidth: 1,
          flexDirection: 'row',
          height: 32,
          padding: space.xs,
          pointerEvents: 'none',
          width: 64,
        }}
      >
        <View
          style={{
            alignItems: 'center',
            backgroundColor: agentMode ? 'transparent' : colors.bgPressed,
            borderRadius: radius.sm,
            flex: 1,
            height: 24,
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={agentMode ? 'chatbubble-ellipses-outline' : 'chatbubble-ellipses'}
            size={16}
            color={agentMode ? colors.textMuted : colors.text}
          />
        </View>
        <View
          style={{
            alignItems: 'center',
            backgroundColor: agentMode ? colors.bgPressed : 'transparent',
            borderRadius: radius.sm,
            flex: 1,
            height: 24,
            justifyContent: 'center',
          }}
        >
          <MaterialCommunityIcons
            name={agentMode ? 'robot' : 'robot-outline'}
            size={16}
            color={agentMode ? colors.text : colors.textMuted}
          />
        </View>
      </View>
    </Pressable>
  );
}

export function SessionAudienceToggle({
  audience,
  isDriver,
  driverName,
  onToggle,
}: {
  audience: SessionComposerAudience;
  isDriver: boolean;
  driverName: string;
  onToggle: () => void;
}) {
  const agentMode = audience === 'agent';
  const description = agentMode
    ? isDriver
      ? 'Prompts this agent.'
      : `Suggests a prompt for ${driverName}.`
    : 'Posts to the discussion without prompting the agent.';
  return (
    <AudienceSwitch
      testID="session-audience-toggle"
      accessibilityHint={description}
      audience={audience}
      onToggle={onToggle}
    />
  );
}
