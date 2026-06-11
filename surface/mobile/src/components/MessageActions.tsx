// Long-press action sheet for a message: quick reactions + reply/edit/delete.

import { Alert, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import type { ChatMessage } from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../lib/theme';
import { selectionHaptic } from '../lib/haptics';

const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🔥', '😢', '🚀', '🙏', '💯', '🤔'];

export interface MessageActionsProps {
  message: ChatMessage | null;
  mine: boolean;
  canReply: boolean;
  onClose: () => void;
  onReact: (m: ChatMessage, emoji: string) => void;
  onReply: (m: ChatMessage) => void;
  onEdit: (m: ChatMessage) => void;
  onDelete: (m: ChatMessage) => void;
}

function Action({
  label,
  destructive,
  onPress,
}: {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: 'center',
        paddingVertical: 13,
        paddingHorizontal: space.lg,
        backgroundColor: pressed ? colors.bgPressed : 'transparent',
      })}
    >
      <Text
        style={{
          color: destructive ? colors.danger : colors.text,
          fontSize: font.md,
          fontWeight: '500',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function MessageActions({
  message,
  mine,
  canReply,
  onClose,
  onReact,
  onReply,
  onEdit,
  onDelete,
}: MessageActionsProps) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const m = message;
  const confirmed = m?.status === 'confirmed' && m.id != null;
  const canCopy = !!m?.text.trim();
  return (
    <Modal visible={m != null} transparent animationType={reduceMotion ? 'none' : 'fade'} onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close message actions"
        style={{ flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' }}
        onPress={onClose}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.bgElevated,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            paddingBottom: insets.bottom + 8,
            paddingTop: space.md,
          }}
        >
          {m && confirmed && (
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: space.sm,
                paddingHorizontal: space.lg,
                paddingBottom: space.md,
              }}
            >
              {QUICK_EMOJI.map((e) => (
                <Pressable
                  key={e}
                  accessibilityRole="button"
                  accessibilityLabel={`React with ${e}`}
                  onPress={() => {
                    selectionHaptic();
                    onReact(m, e);
                    onClose();
                  }}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: pressed ? colors.bgPressed : colors.bgInput,
                    alignItems: 'center',
                    justifyContent: 'center',
                  })}
                >
                  <Text style={{ fontSize: 22 }}>{e}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <View style={{ height: 1, backgroundColor: colors.border }} />
          {m && confirmed && canReply && (
            <Action
              label="Reply in thread"
              onPress={() => {
                onReply(m);
                onClose();
              }}
            />
          )}
          {m && canCopy && (
            <Action
              label="Copy text"
              onPress={() => {
                void Clipboard.setStringAsync(m.text);
                onClose();
              }}
            />
          )}
          {m && confirmed && mine && (
            <Action
              label="Edit message"
              onPress={() => {
                onEdit(m);
                onClose();
              }}
            />
          )}
          {m && confirmed && mine && (
            <Action
              label="Delete message"
              destructive
              onPress={() => {
                onClose();
                Alert.alert('Delete message?', 'This cannot be undone.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => onDelete(m) },
                ]);
              }}
            />
          )}
          <Action label="Cancel" onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
