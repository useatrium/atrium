import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../src/lib/session';
import { colors, font, radius, space } from '../src/lib/theme';

const inputStyle = {
  backgroundColor: colors.bgInput,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  color: colors.text,
  fontSize: font.md,
  paddingHorizontal: space.md,
  paddingVertical: 12,
} as const;

function Label({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.textSecondary,
        fontSize: font.xs,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        marginBottom: 6,
      }}
    >
      {children}
    </Text>
  );
}

// Dev convenience: EXPO_PUBLIC_AUTO_LOGIN="http://host:3001|handle|Display Name"
// prefills and submits the form once (dev builds only).
const AUTO_LOGIN = __DEV__ ? process.env.EXPO_PUBLIC_AUTO_LOGIN : undefined;

export default function Login() {
  const { login } = useSession();
  const [autoServer, autoHandle, autoName] = (AUTO_LOGIN ?? '').split('|');
  const [serverUrl, setServerUrl] = useState(autoServer ?? '');
  const [handle, setHandle] = useState(autoHandle ?? '');
  const [displayName, setDisplayName] = useState(autoName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);

  useEffect(() => {
    if (!autoServer || !autoHandle || autoTried.current) return;
    autoTried.current = true;
    setBusy(true);
    login(autoServer, autoHandle, autoName ?? '')
      .catch((err) => setError(err instanceof Error ? err.message : 'auto-login failed'))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSubmit = serverUrl.trim().length > 0 && handle.trim().length >= 2 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await login(serverUrl, handle.trim().toLowerCase(), displayName.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: space.xl }}
          keyboardShouldPersistTaps="handled"
        >
          <Text
            style={{
              color: colors.text,
              fontSize: 34,
              fontWeight: '800',
              marginBottom: 4,
            }}
          >
            Atrium
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: font.md, marginBottom: space.xl }}>
            Sign in to your workspace
          </Text>

          <View style={{ gap: space.lg }}>
            <View>
              <Label>Server</Label>
              <TextInput
                style={inputStyle}
                value={serverUrl}
                onChangeText={setServerUrl}
                placeholder="http://192.168.1.20:3001"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <Text style={{ color: colors.textFaint, fontSize: font.xs, marginTop: 4 }}>
                Your Atrium server origin. On a real device, use your computer's LAN IP.
              </Text>
            </View>
            <View>
              <Label>Handle</Label>
              <TextInput
                style={inputStyle}
                value={handle}
                onChangeText={setHandle}
                placeholder="alice"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View>
              <Label>Display name</Label>
              <TextInput
                style={inputStyle}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="Alice (leave blank to keep your current name)"
                placeholderTextColor={colors.textFaint}
              />
            </View>

            {error && (
              <Text style={{ color: colors.danger, fontSize: font.sm }}>{error}</Text>
            )}

            <Pressable
              onPress={submit}
              disabled={!canSubmit}
              style={({ pressed }) => ({
                backgroundColor: canSubmit ? colors.accent : colors.bgElevated,
                opacity: pressed ? 0.85 : 1,
                borderRadius: radius.md,
                alignItems: 'center',
                paddingVertical: 14,
                marginTop: space.sm,
              })}
            >
              {busy ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text
                  style={{
                    color: canSubmit ? colors.bg : colors.textFaint,
                    fontSize: font.md,
                    fontWeight: '700',
                  }}
                >
                  Sign in
                </Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
