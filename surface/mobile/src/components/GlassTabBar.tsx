// Floating Liquid-Glass bottom tab bar for the (tabs) expo-router/ui navigator.
//
//   <TabList asChild>
//     <GlassBar>
//       <TabTrigger name="index" href="/" asChild>
//         <GlassTabButton icon="chatbubbles" label="Chat" />
//       </TabTrigger>
//       ...
//     </GlassBar>
//   </TabList>
//
// GlassBar is the floating glass container (TabList's asChild). GlassTabButton is
// a TabTrigger asChild child: TabTrigger forwards `isFocused` + press handlers to
// it. Chat · Agents · Activity · Search, Search bottom-right (thumb reach); "You"
// is the top-left header avatar. Agents pulses while a session runs; Activity
// badges sessions needing attention.
import { forwardRef } from 'react';
import { Pressable, Text, View, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { useTheme } from '../lib/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

/** Glass container — used as `<TabList asChild>`'s child (forwards ref + props). */
export const GlassBar = forwardRef<View, ViewProps>(function GlassBar({ style, children, ...props }, ref) {
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const glass = scheme === 'dark' ? 'rgba(24,24,27,0.82)' : 'rgba(255,255,255,0.82)';
  return (
    <View
      ref={ref}
      accessibilityRole="tablist"
      {...props}
      style={[
        {
          flexDirection: 'row',
          marginHorizontal: 12,
          marginBottom: Math.max(insets.bottom, 10),
          paddingVertical: 8,
          paddingHorizontal: 6,
          borderRadius: 22,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: glass,
          shadowColor: '#000',
          shadowOpacity: 0.45,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 8 },
          elevation: 12,
        },
        // Web-only Liquid-Glass blur (RN style types don't include these keys).
        { backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' } as object,
        style,
      ]}
    >
      {children}
    </View>
  );
});

interface GlassTabButtonProps {
  icon: IoniconName;
  label: string;
  pulse?: boolean;
  badge?: number;
  /** Forwarded by `<TabTrigger asChild>`: isFocused + onPress/onLongPress/href/ref. */
  isFocused?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** A tab button — child of `<TabTrigger asChild>`, which forwards `isFocused` +
 * press handlers. */
export const GlassTabButton = forwardRef<View, GlassTabButtonProps>(function GlassTabButton(
  { icon, label, pulse, badge = 0, isFocused, ...press },
  ref,
) {
  const { colors } = useTheme();
  const tint = isFocused ? colors.accent : colors.textSecondary;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="tab"
      accessibilityState={{ selected: !!isFocused }}
      accessibilityLabel={label + (badge ? `, ${badge} need attention` : '')}
      {...press}
      style={{ flex: 1, alignItems: 'center', gap: 2, minHeight: 44, justifyContent: 'center' }}
    >
      <View>
        <Ionicons name={icon} size={22} color={tint} />
        {pulse && (
          <View
            style={{
              position: 'absolute',
              top: -1,
              right: -3,
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: colors.accent,
            }}
          />
        )}
        {badge > 0 && (
          <View
            style={{
              position: 'absolute',
              top: -5,
              right: -8,
              minWidth: 15,
              height: 15,
              borderRadius: 8,
              paddingHorizontal: 3,
              backgroundColor: colors.danger,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>{badge}</Text>
          </View>
        )}
      </View>
      <Text style={{ color: tint, fontSize: 10, fontWeight: isFocused ? '700' : '500' }}>{label}</Text>
    </Pressable>
  );
});
