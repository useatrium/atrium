import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ReasoningItem } from '@atrium/centaur-client';
import { font, radius, space, useTheme } from '../lib/theme';

export function ReasoningBlock({
  item,
  onLongPress,
}: {
  item: ReasoningItem;
  // The header Pressable wins the gesture over any wrapping Pressable, so the
  // entry-actions long-press must be forwarded here or a collapsed block has
  // no way to open the action sheet.
  onLongPress?: () => void;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const hasSummary = Boolean(item.summary?.trim());
  if (!item.text.trim() && !hasSummary) return null;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.borderSoft,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.sm,
        overflow: 'hidden',
      }}
    >
      <Pressable
        onPress={() => setOpen((value) => !value)}
        onLongPress={onLongPress}
        delayLongPress={250}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Thinking"
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          padding: space.sm,
          backgroundColor: pressed ? colors.bgPressed : 'transparent',
        })}
      >
        <Text style={{ color: colors.textMuted, fontSize: font.xs, width: 10 }}>
          {open ? '▾' : '▸'}
        </Text>
        <Text
          style={{
            color: colors.textMuted,
            fontSize: font.xs,
            fontWeight: '700',
          }}
        >
          Thinking
        </Text>
        {!open && hasSummary ? (
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              minWidth: 0,
              color: colors.textMuted,
              fontSize: font.xs,
            }}
          >
            {item.summary}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.borderSoft,
            padding: space.sm,
            gap: space.sm,
          }}
        >
          {hasSummary ? (
            <Text style={{ color: colors.textMuted, fontSize: font.xs, lineHeight: 16 }}>
              {item.summary}
            </Text>
          ) : null}
          <Text style={{ color: colors.textMuted, fontSize: font.xs, lineHeight: 16 }}>
            {item.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
