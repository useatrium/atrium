import { useRef } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useModalAccessibilityFocus } from '../../lib/accessibility';
import { font, radius, space, useTheme } from '../../lib/theme';
import type { Turn } from './turns';

export function TurnsSheet({
  visible,
  turns,
  onJump,
  onClose,
}: {
  visible: boolean;
  turns: Turn[];
  onJump: (itemId: string) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const titleRef = useRef<Text>(null);

  useModalAccessibilityFocus(titleRef, visible);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View
        testID="turns-sheet"
        style={{
          flex: 1,
          justifyContent: 'flex-end',
          backgroundColor: colors.scrim,
        }}
      >
        <Pressable
          accessible={false}
          onPress={onClose}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            maxHeight: '70%',
            backgroundColor: colors.bg,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
              paddingHorizontal: space.md,
              height: 48,
            }}
          >
            <Text
              ref={titleRef}
              accessibilityRole="header"
              style={{ flex: 1, color: colors.text, fontSize: font.md, fontWeight: '800' }}
            >
              Turns
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close turns"
              style={{ paddingHorizontal: space.sm, paddingVertical: space.sm }}
            >
              <Text style={{ color: colors.textMuted, fontSize: font.lg }}>✕</Text>
            </Pressable>
          </View>
          {turns.length === 0 ? (
            <View style={{ padding: space.lg, alignItems: 'center' }}>
              <Text style={{ color: colors.textMuted, fontSize: font.sm }}>No turns.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ paddingVertical: space.xs }}>
              {turns.map((turn) => (
                <Pressable
                  key={turn.id}
                  testID="turn-row"
                  accessibilityRole="button"
                  accessibilityLabel={turn.label}
                  accessibilityHint="Jumps to this turn in the transcript"
                  onPress={() => {
                    onJump(turn.itemId);
                    onClose();
                  }}
                  style={({ pressed }) => ({
                    paddingHorizontal: space.md,
                    paddingVertical: space.md,
                    backgroundColor: pressed ? colors.bgPressed : colors.bg,
                  })}
                >
                  <Text numberOfLines={1} style={{ color: colors.text, fontSize: font.sm, fontWeight: '600' }}>
                    {turn.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}
