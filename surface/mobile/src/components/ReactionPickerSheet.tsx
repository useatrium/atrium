import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { REACTION_GROUPS, searchReactions } from '@atrium/surface-client/reactions';
import { useModalAccessibilityFocus } from '../lib/accessibility';
import { font, radius, space, useTheme } from '../lib/theme';

export interface ReactionPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}

function ReactionButton({ emoji, onSelect }: { emoji: string; onSelect: (emoji: string) => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`React with ${emoji}`}
      onPress={() => onSelect(emoji)}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: pressed ? colors.bgPressed : colors.bgInput,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      <Text style={{ fontSize: 22 }}>{emoji}</Text>
    </Pressable>
  );
}

export function ReactionPickerSheet({ visible, onClose, onSelect }: ReactionPickerSheetProps) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const searchRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');
  const trimmedQuery = query.trim();
  const filtered = useMemo(() => searchReactions(query), [query]);

  useModalAccessibilityFocus(searchRef, visible);

  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType={reduceMotion ? 'none' : 'fade'} onRequestClose={onClose}>
      <Pressable
        // Scrim: tap-to-dismiss for sighted users. Keep it out of the a11y
        // tree so the sheet children remain individually reachable.
        accessible={false}
        importantForAccessibility="no"
        style={{ flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' }}
        onPress={onClose}
      >
        <Pressable
          // Inner sheet only swallows taps. It must not become one combined
          // accessibility node, or the reaction buttons disappear from VO.
          accessible={false}
          importantForAccessibility="no"
          accessibilityViewIsModal
          onPress={() => {}}
          style={{
            maxHeight: '80%',
            backgroundColor: colors.bgElevated,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            paddingBottom: insets.bottom + space.sm,
            paddingTop: space.md,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              paddingHorizontal: space.lg,
              paddingBottom: space.md,
            }}
          >
            <TextInput
              ref={searchRef}
              accessibilityLabel="Search reactions"
              value={query}
              onChangeText={setQuery}
              placeholder="Search reactions"
              placeholderTextColor={colors.textFaint}
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
              style={{
                flex: 1,
                minHeight: 44,
                backgroundColor: colors.bgInput,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                color: colors.text,
                fontSize: font.md,
                paddingHorizontal: space.md,
                paddingVertical: 10,
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close reaction picker"
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: pressed ? colors.bgPressed : colors.bgInput,
                alignItems: 'center',
                justifyContent: 'center',
              })}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 22, fontWeight: '600' }}>×</Text>
            </Pressable>
          </View>
          <View style={{ height: 1, backgroundColor: colors.border }} />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: space.lg,
              paddingTop: space.md,
              paddingBottom: space.lg,
              gap: space.lg,
            }}
          >
            {trimmedQuery.length === 0 ? (
              REACTION_GROUPS.map((group) => (
                <View key={group.name} style={{ gap: space.sm }}>
                  <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>{group.name}</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                    {group.emojis.map((emoji) => (
                      <ReactionButton key={emoji} emoji={emoji} onSelect={onSelect} />
                    ))}
                  </View>
                </View>
              ))
            ) : filtered.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {filtered.map((emoji) => (
                  <ReactionButton key={emoji} emoji={emoji} onSelect={onSelect} />
                ))}
              </View>
            ) : (
              <Text style={{ color: colors.textMuted, fontSize: font.sm }}>No reactions found</Text>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
