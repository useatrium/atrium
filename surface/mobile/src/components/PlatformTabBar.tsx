import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { Platform, View, type ColorValue } from 'react-native';
import { useTheme } from '../lib/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

export const navigationTargetSize = Platform.OS === 'ios' ? 44 : 48;

export function TabIcon({
  name,
  color,
  live = false,
}: {
  name: IoniconName;
  color: ColorValue;
  live?: boolean;
}) {
  const { colors } = useTheme();

  return (
    <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={name} size={22} color={color} />
      {live ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: 'absolute',
            top: 1,
            right: 0,
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: colors.accent,
            borderWidth: 1,
            borderColor: colors.bgElevated,
          }}
        />
      ) : null}
    </View>
  );
}
