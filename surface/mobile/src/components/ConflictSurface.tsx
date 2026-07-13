import { useEffect, useRef, useState, type JSX } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { HubFileConflict, HubFileConflictSide, HubFileResolveChoice } from '@atrium/surface-client';
import { font, radius, space, useTheme, type Colors } from '../lib/theme';

type SideKey = 'left' | 'right';

export function ConflictSurface(props: {
  conflict: HubFileConflict;
  onResolve: (choice: HubFileResolveChoice) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
}): JSX.Element {
  const { conflict, onResolve, onCancel, busy } = props;
  const { colors } = useTheme();
  const mountedRef = useRef(true);
  const [selectedSide, setSelectedSide] = useState<SideKey>('left');
  const [merged, setMerged] = useState(conflict.markers);
  const [localBusy, setLocalBusy] = useState(false);
  const disabled = Boolean(busy || localBusy);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setMerged(conflict.markers);
    setSelectedSide('left');
  }, [conflict]);

  async function resolve(choice: HubFileResolveChoice) {
    if (disabled) return;
    setLocalBusy(true);
    try {
      await onResolve(choice);
    } finally {
      if (mountedRef.current) setLocalBusy(false);
    }
  }

  const side = selectedSide === 'left' ? conflict.left : conflict.right;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
        }}
      >
        <View
          style={{
            backgroundColor: colors.dangerSurface,
            borderColor: colors.dangerBorder,
            borderWidth: 1,
            borderRadius: radius.sm,
            paddingHorizontal: space.sm,
            paddingVertical: space.xs,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: font.xs, fontWeight: '800' }}>Conflict</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{ color: colors.text, fontFamily: monoFont(), fontSize: font.xs, fontWeight: '700' }}
            numberOfLines={1}
          >
            {conflict.path}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
            v{conflict.conflictSeq}
            {conflict.baseSeq != null ? ` from base v${conflict.baseSeq}` : ''}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel conflict resolution"
          disabled={disabled}
          hitSlop={8}
          onPress={onCancel}
          style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}
        >
          <Ionicons name="close" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.md, gap: space.md, paddingBottom: space.xl }}
      >
        <View
          style={{
            flexDirection: 'row',
            backgroundColor: colors.bgElevated,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 8,
            padding: space.xs,
            gap: space.xs,
          }}
        >
          <SideToggle
            colors={colors}
            selected={selectedSide === 'left'}
            label={conflict.left.label || 'Theirs'}
            accessibilityLabel="Show theirs"
            onPress={() => setSelectedSide('left')}
          />
          <SideToggle
            colors={colors}
            selected={selectedSide === 'right'}
            label={conflict.right.label || 'Yours'}
            accessibilityLabel="Show yours"
            onPress={() => setSelectedSide('right')}
          />
        </View>

        <SidePreview side={side} colors={colors} />

        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <ActionButton
            colors={colors}
            label="Keep theirs"
            icon="arrow-down-circle-outline"
            disabled={disabled}
            onPress={() => void resolve({ kind: 'left' })}
          />
          <ActionButton
            colors={colors}
            label="Keep yours"
            icon="arrow-up-circle-outline"
            disabled={disabled}
            onPress={() => void resolve({ kind: 'right' })}
          />
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ color: colors.textSecondary, fontSize: font.sm, fontWeight: '800' }}>Merged resolution</Text>
          <TextInput
            accessibilityLabel="Merged resolution"
            editable={!disabled}
            multiline
            value={merged}
            onChangeText={setMerged}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            style={{
              minHeight: 220,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 8,
              backgroundColor: colors.bgInput,
              color: colors.text,
              fontFamily: monoFont(),
              fontSize: font.xs,
              lineHeight: 18,
              padding: space.md,
              opacity: disabled ? 0.65 : 1,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Apply merged"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => void resolve({ kind: 'merged', text: merged })}
            style={{
              minHeight: 44,
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: space.sm,
              backgroundColor: colors.accent,
              opacity: disabled ? 0.55 : 1,
            }}
          >
            <Ionicons name="git-merge-outline" size={18} color={colors.onAccent} />
            <Text style={{ color: colors.onAccent, fontSize: font.sm, fontWeight: '800' }}>Apply merged</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function SideToggle({
  colors,
  selected,
  label,
  accessibilityLabel,
  onPress,
}: {
  colors: Colors;
  selected: boolean;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        flex: 1,
        minHeight: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.sm,
        backgroundColor: selected ? colors.accentBg : 'transparent',
        paddingHorizontal: space.sm,
      }}
    >
      <Text
        style={{ color: selected ? colors.accent : colors.textSecondary, fontSize: font.xs, fontWeight: '800' }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SidePreview({ side, colors }: { side: HubFileConflictSide; colors: Colors }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        overflow: 'hidden',
        backgroundColor: colors.bgElevated,
      }}
    >
      <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border, padding: space.sm, gap: space.xs }}>
        <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }} numberOfLines={1}>
          {side.label}
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontFamily: monoFont() }} numberOfLines={1}>
          {side.author}
          {side.sha ? ` · ${side.sha.slice(0, 12)}` : ' · deleted'}
        </Text>
      </View>
      <ScrollView horizontal>
        <ScrollView style={{ maxHeight: 260 }} contentContainerStyle={{ padding: space.md }}>
          <Text style={{ color: colors.textSecondary, fontFamily: monoFont(), fontSize: font.xs, lineHeight: 18 }}>
            {side.text || ''}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function ActionButton({
  colors,
  label,
  icon,
  disabled,
  onPress,
}: {
  colors: Colors;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        flex: 1,
        minHeight: 44,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: space.sm,
        backgroundColor: colors.bgElevated,
        opacity: disabled ? 0.55 : 1,
        paddingHorizontal: space.sm,
      }}
    >
      <Ionicons name={icon} size={17} color={colors.textSecondary} />
      <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function monoFont() {
  return Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
}
