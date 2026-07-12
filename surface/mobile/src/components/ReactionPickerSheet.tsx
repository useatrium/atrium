import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { REACTION_GROUPS, searchReactions } from '@atrium/surface-client/reactions';
import { useModalAccessibilityFocus } from '../lib/accessibility';
import { font, radius, space, useTheme } from '../lib/theme';

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

/**
 * The searchable reaction picker, rendered INLINE (no Modal of its own). It is
 * embedded inside the MessageActions sheet's single Modal — stacking a second
 * Modal over the actions Modal fails to present on iOS, so we swap content in
 * place instead.
 */
export function ReactionPickerBody({ onSelect, onBack }: { onSelect: (emoji: string) => void; onBack: () => void }) {
  const { colors } = useTheme();
  const searchRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');
  const trimmedQuery = query.trim();
  const filtered = useMemo(() => searchReactions(query), [query]);

  useModalAccessibilityFocus(searchRef, true);

  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.lg,
          paddingBottom: space.md,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to actions"
          onPress={onBack}
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
          <Text style={{ color: colors.textSecondary, fontSize: 26, fontWeight: '600', marginTop: -2 }}>‹</Text>
        </Pressable>
        <TextInput
          ref={searchRef}
          accessibilityLabel="Search reactions"
          value={query}
          onChangeText={setQuery}
          placeholder="Search reactions"
          placeholderTextColor={colors.textFaint}
          autoCorrect={false}
          autoCapitalize="none"
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
      </View>
      <View style={{ height: 1, backgroundColor: colors.border }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: 320 }}
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
    </View>
  );
}
