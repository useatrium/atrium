import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { AgentMark } from './AgentMark';

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
  const { colors } = useTheme();
  const agentMode = audience === 'agent';
  const description = agentMode
    ? isDriver
      ? 'Prompts this agent.'
      : `Suggests a prompt for ${driverName}.`
    : 'Posts to the discussion without prompting the agent.';
  return (
    <Pressable
      testID="session-audience-toggle"
      accessibilityRole="button"
      accessibilityState={{ selected: agentMode }}
      accessibilityLabel={
        agentMode ? 'Agent mode selected. Switch to People mode.' : 'People mode selected. Switch to Agent mode.'
      }
      accessibilityHint={description}
      onPress={onToggle}
      style={({ pressed }) => ({
        alignItems: 'center',
        backgroundColor: agentMode ? colors.accent : pressed ? colors.bgPressed : colors.bgElevated,
        borderColor: agentMode ? colors.accent : colors.border,
        borderRadius: 24,
        borderWidth: 1,
        height: 48,
        justifyContent: 'center',
        opacity: pressed ? 0.82 : 1,
        width: 48,
      })}
    >
      {agentMode ? (
        <AgentMark size={24} />
      ) : (
        <Ionicons name="chatbubbles-outline" size={23} color={colors.textSecondary} />
      )}
    </Pressable>
  );
}
