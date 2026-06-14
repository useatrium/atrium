import { ScrollView, Pressable, Switch, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import {
  ACCENTS,
  FONT_SCALES,
  type Accent,
  type FontScale,
  type MotionPref,
  type ThemeMode,
} from '@atrium/surface-client';
import { useChat } from '../../src/lib/chat';
import { useSession } from '../../src/lib/session';
import {
  getRegisteredPushToken,
  getRegisteredVoipPushToken,
  setRegisteredVoipPushToken,
  unregisterPush,
} from '../../src/lib/notifications';
import { buildColors, font, radius, space, useTheme } from '../../src/lib/theme';

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const motionOptions: { value: MotionPref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'reduced', label: 'Reduced' },
  { value: 'full', label: 'Full' },
];

const fontLabels = ['S', 'M', 'L', 'XL'] as const;

function SectionLabel({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <Text
      maxFontSizeMultiplier={2}
      style={{
        color: colors.textMuted,
        fontSize: font.xs,
        fontWeight: '800',
        paddingHorizontal: space.lg,
        paddingBottom: space.sm,
        paddingTop: space.lg,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </Text>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: colors.borderSoft,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.md,
        minHeight: 56,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
      }}
    >
      <Text maxFontSizeMultiplier={2} style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        overflow: 'hidden',
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={{
              minHeight: 44,
              minWidth: 58,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: space.sm,
              backgroundColor: selected ? colors.accentBg : colors.bgInput,
            }}
          >
            <Text
              maxFontSizeMultiplier={2}
              style={{
                color: selected ? colors.accent : colors.textSecondary,
                fontSize: font.sm,
                fontWeight: selected ? '800' : '600',
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function SettingsScreen() {
  const { api } = useChat();
  const { logout } = useSession();
  const { colors, scheme, prefs, setPrefs } = useTheme();
  const version = Constants.expoConfig?.version ?? '0.1.0';

  const logOut = () => {
    void Promise.all([
      unregisterPush(api, getRegisteredPushToken()),
      unregisterPush(api, getRegisteredVoipPushToken()),
    ]).finally(() => {
      // Clear the cached VoIP token so a stale value isn't reused next session.
      setRegisteredVoipPushToken(null);
      void logout();
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Settings', headerBackButtonDisplayMode: 'minimal' }} />
      <ScrollView contentContainerStyle={{ paddingBottom: space.xl }}>
        <SectionLabel>Appearance</SectionLabel>
        <Row label="Theme">
          <Segmented
            value={prefs.theme}
            options={themeOptions}
            label="Theme"
            onChange={(theme) => setPrefs({ theme })}
          />
        </Row>
        <Row label="Accent">
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Accent"
            style={{ flexDirection: 'row', gap: space.sm }}
          >
            {ACCENTS.map((accent) => {
              const selected = prefs.accent === accent;
              const swatch = buildColors(scheme, accent, prefs.highContrast).accent;
              return (
                <Pressable
                  key={accent}
                  accessibilityRole="radio"
                  accessibilityLabel={`${accent} accent`}
                  accessibilityState={{ selected }}
                  onPress={() => setPrefs({ accent: accent as Accent })}
                  style={{
                    minWidth: 44,
                    minHeight: 44,
                    borderRadius: 22,
                    borderWidth: selected ? 3 : 1,
                    borderColor: selected ? colors.accent : colors.border,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <View
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 12,
                      backgroundColor: swatch,
                    }}
                  />
                </Pressable>
              );
            })}
          </View>
        </Row>
        <Row label="Text size">
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Text size"
            style={{ flexDirection: 'row', gap: space.xs }}
          >
            {FONT_SCALES.map((scale, index) => {
              const selected = prefs.fontScale === scale;
              return (
                <Pressable
                  key={scale}
                  accessibilityRole="radio"
                  accessibilityLabel={`${fontLabels[index]} text size`}
                  accessibilityState={{ selected }}
                  onPress={() => setPrefs({ fontScale: scale as FontScale })}
                  style={{
                    minWidth: 44,
                    minHeight: 44,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: selected ? colors.accent : colors.border,
                    backgroundColor: selected ? colors.accentBg : colors.bgInput,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text
                    maxFontSizeMultiplier={2}
                    style={{
                      color: selected ? colors.accent : colors.textSecondary,
                      fontSize: font.sm,
                      fontWeight: '800',
                    }}
                  >
                    {fontLabels[index]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Row>
        <Row label="High contrast">
          <Switch
            accessibilityRole="switch"
            accessibilityLabel="High contrast"
            accessibilityState={{ checked: prefs.highContrast }}
            value={prefs.highContrast}
            onValueChange={(highContrast) => setPrefs({ highContrast })}
            trackColor={{ false: colors.switchTrackOff, true: colors.accent }}
            thumbColor={prefs.highContrast ? colors.onAccent : colors.switchThumbOff}
          />
        </Row>
        <Row label="Motion">
          <Segmented
            value={prefs.motion}
            options={motionOptions}
            label="Motion"
            onChange={(motion) => setPrefs({ motion })}
          />
        </Row>

        <SectionLabel>Account</SectionLabel>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log out"
          onPress={logOut}
          style={({ pressed }) => ({
            minHeight: 56,
            justifyContent: 'center',
            paddingHorizontal: space.lg,
            backgroundColor: pressed ? colors.bgPressed : 'transparent',
          })}
        >
          <Text maxFontSizeMultiplier={2} style={{ color: colors.danger, fontSize: font.md, fontWeight: '800' }}>
            Log out
          </Text>
        </Pressable>
        <Text
          maxFontSizeMultiplier={2}
          style={{
            color: colors.textFaint,
            fontSize: font.xs,
            padding: space.lg,
            textAlign: 'center',
          }}
        >
          Atrium {version}
        </Text>
      </ScrollView>
    </View>
  );
}
