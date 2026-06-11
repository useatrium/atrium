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
import { createApi, type AuthMethods } from '@atrium/surface-client';
import { normalizeServerUrl, useSession } from '../src/lib/session';
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
  const { login, loginWithEmailCode } = useSession();
  const [autoServer, autoHandle, autoName] = (AUTO_LOGIN ?? '').split('|');
  const [serverUrl, setServerUrl] = useState(autoServer ?? '');
  const [methods, setMethods] = useState<AuthMethods>({ open: true, email: true, google: false });
  const [emailStep, setEmailStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
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

  useEffect(() => {
    if (!serverUrl.trim()) return;
    let canceled = false;
    const timeout = setTimeout(() => {
      const api = createApi({ baseUrl: normalizeServerUrl(serverUrl) });
      api
        .authMethods()
        .then((next) => {
          if (!canceled) setMethods(next);
        })
        .catch(() => {});
    }, 300);
    return () => {
      canceled = true;
      clearTimeout(timeout);
    };
  }, [serverUrl]);

  const canRequestCode = serverUrl.trim().length > 0 && email.trim().length > 0 && !busy;
  const canVerifyCode =
    serverUrl.trim().length > 0 && email.trim().length > 0 && code.trim().length === 6 && !busy;
  const canSubmitHandle = serverUrl.trim().length > 0 && handle.trim().length >= 2 && !busy;

  const requestCode = async () => {
    if (!canRequestCode) return;
    setBusy(true);
    setError(null);
    try {
      const api = createApi({ baseUrl: normalizeServerUrl(serverUrl) });
      await api.requestEmailCode(email.trim());
      setEmailStep('code');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request a code.');
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    if (!canVerifyCode) return;
    setBusy(true);
    setError(null);
    try {
      await loginWithEmailCode(serverUrl, email.trim(), code.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  const submitHandle = async () => {
    if (!canSubmitHandle) return;
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
              <Label>Email</Label>
              <TextInput
                style={[inputStyle, emailStep === 'code' ? { color: colors.textMuted } : null]}
                value={email}
                onChangeText={setEmail}
                placeholder="alice@example.com"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                editable={emailStep === 'email'}
              />
            </View>

            {emailStep === 'code' && (
              <View>
                <Label>Code</Label>
                <TextInput
                  style={inputStyle}
                  value={code}
                  onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  placeholderTextColor={colors.textFaint}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                />
              </View>
            )}

            <Pressable
              onPress={emailStep === 'email' ? requestCode : verifyCode}
              disabled={emailStep === 'email' ? !canRequestCode : !canVerifyCode}
              style={({ pressed }) => {
                const enabled = emailStep === 'email' ? canRequestCode : canVerifyCode;
                return {
                  backgroundColor: enabled ? colors.accent : colors.bgElevated,
                  opacity: pressed ? 0.85 : 1,
                  borderRadius: radius.md,
                  alignItems: 'center',
                  paddingVertical: 14,
                  marginTop: space.sm,
                };
              }}
            >
              {busy ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text
                  style={{
                    color:
                      emailStep === 'email'
                        ? canRequestCode
                          ? colors.bg
                          : colors.textFaint
                        : canVerifyCode
                          ? colors.bg
                          : colors.textFaint,
                    fontSize: font.md,
                    fontWeight: '700',
                  }}
                >
                  {emailStep === 'email' ? 'Email me a code' : 'Sign in'}
                </Text>
              )}
            </Pressable>

            {emailStep === 'code' && (
              <Pressable
                onPress={() => {
                  setEmailStep('email');
                  setCode('');
                  setError(null);
                }}
              >
                <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
                  Use a different email
                </Text>
              </Pressable>
            )}

            {/* Google OAuth needs a native redirect/deep-link flow; web only for this round. */}

            {methods.open && (
              <View
                style={{
                  borderTopWidth: 1,
                  borderTopColor: colors.border,
                  paddingTop: space.lg,
                  gap: space.lg,
                }}
              >
                <Text
                  style={{ color: colors.textMuted, fontSize: font.xs, textAlign: 'center' }}
                >
                  dev login
                </Text>
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

                <Pressable
                  onPress={submitHandle}
                  disabled={!canSubmitHandle}
                  style={({ pressed }) => ({
                    backgroundColor: canSubmitHandle ? colors.bgPressed : colors.bgElevated,
                    opacity: pressed ? 0.85 : 1,
                    borderRadius: radius.md,
                    alignItems: 'center',
                    paddingVertical: 14,
                    marginTop: space.sm,
                  })}
                >
                  {busy ? (
                    <ActivityIndicator color={colors.text} />
                  ) : (
                    <Text
                      style={{
                        color: canSubmitHandle ? colors.text : colors.textFaint,
                        fontSize: font.md,
                        fontWeight: '700',
                      }}
                    >
                      Join with handle
                    </Text>
                  )}
                </Pressable>
              </View>
            )}

            {error && <Text style={{ color: colors.danger, fontSize: font.sm }}>{error}</Text>}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
