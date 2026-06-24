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
import { font, radius, space, useTheme } from '../src/lib/theme';

function Label({ children }: { children: string }) {
  const { colors } = useTheme();
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
  const { colors } = useTheme();
  const [autoServer, autoHandle, autoName] = (AUTO_LOGIN ?? '').split('|');
  const [serverUrl, setServerUrl] = useState(autoServer ?? '');
  const [methods, setMethods] = useState<AuthMethods>({
    open: true,
    email: true,
    google: false,
    calls: false,
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [emailVisible, setEmailVisible] = useState(false);
  const [emailStep, setEmailStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [handle, setHandle] = useState(autoHandle ?? '');
  const [displayName, setDisplayName] = useState(autoName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverInputRef = useRef<TextInput>(null);
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
  const canPressHandle = handle.trim().length >= 2 && !busy;
  const canSubmitHandle = serverUrl.trim().length > 0 && handle.trim().length >= 2 && !busy;
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

  const revealServerField = () => {
    setAdvancedOpen(true);
    setTimeout(() => serverInputRef.current?.focus(), 0);
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
    if (!serverUrl.trim()) {
      setError('Enter your Atrium server origin to continue.');
      revealServerField();
      return;
    }
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
          <View style={{ width: '100%', maxWidth: 460, alignSelf: 'center' }}>
            <Text
              style={{
                color: colors.text,
                fontSize: 38,
                fontWeight: '800',
                marginBottom: 8,
              }}
            >
              Atrium
            </Text>
            <Text
              style={{
                color: colors.textMuted,
                fontSize: font.lg,
                lineHeight: 26,
                marginBottom: space.xl,
              }}
            >
              Where your team and AI agents work side by side.
            </Text>

            <View style={{ gap: space.lg }}>
              {methods.open && (
                <View style={{ gap: space.lg }}>
                  <View>
                    <Label>Handle</Label>
                    <TextInput
                      accessibilityLabel="Handle"
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
                      accessibilityLabel="Display name"
                      style={inputStyle}
                      value={displayName}
                      onChangeText={setDisplayName}
                      placeholder="Alice (optional)"
                      placeholderTextColor={colors.textFaint}
                    />
                  </View>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Enter Atrium with handle"
                    accessibilityState={{ disabled: !canPressHandle, busy }}
                    onPress={submitHandle}
                    disabled={!canPressHandle}
                    style={({ pressed }) => ({
                      backgroundColor: canPressHandle ? colors.accent : colors.bgElevated,
                      opacity: pressed ? 0.85 : 1,
                      borderRadius: radius.md,
                      alignItems: 'center',
                      paddingVertical: 14,
                      marginTop: space.sm,
                    })}
                  >
                    {busy ? (
                      <ActivityIndicator color={colors.onAccent} />
                    ) : (
                      <Text
                        style={{
                          color: canPressHandle ? colors.onAccent : colors.textFaint,
                          fontSize: font.md,
                          fontWeight: '800',
                        }}
                      >
                        Enter Atrium
                      </Text>
                    )}
                  </Pressable>
                </View>
              )}

              <View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    advancedOpen ? 'Hide advanced server settings' : 'Show advanced server settings'
                  }
                  accessibilityState={{ expanded: advancedOpen }}
                  onPress={() => setAdvancedOpen((open) => !open)}
                  style={({ pressed }) => ({
                    opacity: pressed ? 0.75 : 1,
                    paddingVertical: space.sm,
                  })}
                >
                  <Text style={{ color: colors.textSecondary, fontSize: font.sm, fontWeight: '700' }}>
                    {advancedOpen ? 'Hide advanced' : 'Advanced'}
                  </Text>
                </Pressable>

                {advancedOpen && (
                  <View style={{ marginTop: space.sm }}>
                    <Label>Server</Label>
                    <TextInput
                      accessibilityLabel="Server"
                      ref={serverInputRef}
                      style={inputStyle}
                      value={serverUrl}
                      onChangeText={setServerUrl}
                      placeholder="http://192.168.1.20:3001"
                      placeholderTextColor={colors.textFaint}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                    />
                    <Text style={{ color: colors.textMuted, fontSize: font.xs, marginTop: 4 }}>
                      Your Atrium server origin. On a real device, use your computer's LAN IP.
                    </Text>
                  </View>
                )}
              </View>

              {methods.email && !emailVisible && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Sign in with email instead"
                  onPress={() => {
                    setEmailVisible(true);
                    setError(null);
                  }}
                  style={({ pressed }) => ({
                    opacity: pressed ? 0.75 : 1,
                    paddingVertical: space.sm,
                  })}
                >
                  <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
                    Sign in with email instead
                  </Text>
                </Pressable>
              )}

              {methods.email && emailVisible && (
                <View
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: colors.border,
                    paddingTop: space.lg,
                    gap: space.lg,
                  }}
                >
                  <View>
                    <Label>Email</Label>
                    <TextInput
                      accessibilityLabel="Email"
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
                        accessibilityLabel="Code"
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
                    accessibilityRole="button"
                    accessibilityLabel={emailStep === 'email' ? 'Email me a code' : 'Sign in with email code'}
                    accessibilityState={{
                      disabled: emailStep === 'email' ? !canRequestCode : !canVerifyCode,
                      busy,
                    }}
                    onPress={emailStep === 'email' ? requestCode : verifyCode}
                    disabled={emailStep === 'email' ? !canRequestCode : !canVerifyCode}
                    style={({ pressed }) => {
                      const enabled = emailStep === 'email' ? canRequestCode : canVerifyCode;
                      return {
                        backgroundColor: enabled ? colors.bgPressed : colors.bgElevated,
                        opacity: pressed ? 0.85 : 1,
                        borderRadius: radius.md,
                        alignItems: 'center',
                        paddingVertical: 14,
                        marginTop: space.sm,
                      };
                    }}
                  >
                    {busy ? (
                      <ActivityIndicator color={colors.text} />
                    ) : (
                      <Text
                        style={{
                          color:
                            emailStep === 'email'
                              ? canRequestCode
                                ? colors.text
                                : colors.textFaint
                              : canVerifyCode
                                ? colors.text
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
                      accessibilityRole="button"
                      accessibilityLabel="Use a different email"
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
                </View>
              )}

              {/* Google OAuth needs a native redirect/deep-link flow; web only for this round. */}
              {methods.google && Platform.OS === 'web' && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Continue with Google"
                  onPress={() => {
                    const base = normalizeServerUrl(serverUrl);
                    window.location.href = `${base}/api/auth/google/start`;
                  }}
                  style={({ pressed }) => ({
                    backgroundColor: colors.bgElevated,
                    opacity: pressed ? 0.85 : 1,
                    borderRadius: radius.md,
                    alignItems: 'center',
                    paddingVertical: 14,
                  })}
                >
                  <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }}>
                    Continue with Google
                  </Text>
                </Pressable>
              )}

              {error && <Text style={{ color: colors.danger, fontSize: font.sm }}>{error}</Text>}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
