// Mobile work surfaces (Phase 4 parity) — the peek→pin→detach ladder degrades on
// mobile to "strip → tap → full-screen → back" (peek is the ceiling: no pin, no
// detach). This is the full-screen container; it hosts one surface at a time
// behind a tab bar, the RN counterpart of web's WorkDrawer.
import { useRef, type ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, Text, View } from 'react-native';
import { useModalAccessibilityFocus } from '../../lib/accessibility';
import { font, space, useTheme } from '../../lib/theme';

export interface WorkSurfaceTab {
  key: string;
  label: string;
  count: number;
  danger?: boolean;
  /** Rendered as the full-screen body when this tab is active. */
  render: () => ReactNode;
}

export function MobileWorkSheet({
  visible,
  tabs,
  activeKey,
  onTab,
  onClose,
}: {
  visible: boolean;
  tabs: WorkSurfaceTab[];
  activeKey: string | null;
  onTab: (key: string) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const firstTabRef = useRef<View>(null);
  const active = tabs.find((t) => t.key === activeKey) ?? tabs[0];

  useModalAccessibilityFocus(firstTabRef, visible && tabs.length > 0);

  return (
    <Modal visible={visible && tabs.length > 0} animationType="slide" onRequestClose={onClose}>
      <View testID="mobile-work-sheet" accessibilityViewIsModal style={{ flex: 1, backgroundColor: colors.bg }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            paddingHorizontal: space.sm,
            height: 48,
          }}
        >
          <View style={{ flexDirection: 'row', flex: 1, alignItems: 'center' }}>
            {tabs.map((t) => {
              const isActive = t.key === active?.key;
              return (
                <Pressable
                  ref={t.key === tabs[0]?.key ? firstTabRef : undefined}
                  key={t.key}
                  onPress={() => onTab(t.key)}
                  accessibilityRole="tab"
                  accessibilityHint={`Shows the ${t.label} work surface`}
                  accessibilityState={{ selected: isActive }}
                  style={{
                    minHeight: 48,
                    justifyContent: 'center',
                    paddingHorizontal: space.sm,
                    borderBottomWidth: 2,
                    borderBottomColor: isActive ? colors.accent : 'transparent',
                  }}
                >
                  <Text
                    style={{
                      color: isActive ? colors.text : colors.textMuted,
                      fontSize: font.sm,
                      fontWeight: '700',
                    }}
                  >
                    {t.label}{' '}
                    <Text style={{ color: t.danger ? colors.danger : colors.textMuted, fontWeight: '400' }}>
                      · {t.count}
                    </Text>
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close work surfaces"
            hitSlop={space.xs}
            style={{
              width: 48,
              height: 48,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
            }}
          >
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </Pressable>
        </View>
        <View style={{ flex: 1 }}>{active?.render()}</View>
      </View>
    </Modal>
  );
}
