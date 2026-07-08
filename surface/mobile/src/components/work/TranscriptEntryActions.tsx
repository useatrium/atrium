import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';

export function TranscriptActiveEntryFrame({
  active,
  onActions,
  children,
}: {
  active: boolean;
  onActions: () => void;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ position: 'relative' }}>
      {children}
      {active ? (
        <Pressable
          testID="transcript-entry-actions-button"
          accessibilityRole="button"
          accessibilityLabel="Message actions"
          hitSlop={10}
          // The transcript ScrollView clears the active entry on any touch; without
          // this, that clear unmounts this button mid-gesture and the tap never lands.
          onTouchStart={(event) => event.stopPropagation()}
          onPress={onActions}
          style={({ pressed }) => ({
            position: 'absolute',
            top: -6,
            right: 0,
            minWidth: 44,
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 22,
            backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
            borderWidth: 1,
            borderColor: colors.border,
          })}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}
