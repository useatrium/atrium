import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  Pressable,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ACCENTS,
  ApiError,
  FONT_SCALES,
  type ConnectionStatus,
  type Accent,
  type FontScale,
  type MotionPref,
  type NotificationMessagePref,
  type NotificationPrefs,
  type ProviderCredentialProvider,
  type ProviderCredentialStatus,
  type ThemeMode,
} from '@atrium/surface-client';
import { useChat } from '../../src/lib/chat';
import { useSession } from '../../src/lib/session';
import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '../../src/lib/accessibility';
import {
  getRegisteredPushToken,
  getRegisteredVoipPushToken,
  getPushPermissionStatus,
  loadDevicePushEnabled,
  registerForPush,
  setDevicePushEnabled,
  setRegisteredVoipPushToken,
  unregisterPush,
  type PushPermissionStatus,
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

const messageNotificationOptions: { value: NotificationMessagePref; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'dm_mention', label: 'DMs & @' },
  { value: 'off', label: 'Off' },
];

const fontLabels = ['S', 'M', 'L', 'XL'] as const;

const providerConfigs: Record<
  ProviderCredentialProvider,
  {
    title: string;
    fieldLabel: string;
    hint: string;
    placeholder: string;
    multiline: boolean;
  }
> = {
  'claude-code': {
    title: 'Claude Code',
    fieldLabel: 'Token',
    hint: 'Run claude setup-token and paste the token here.',
    placeholder: 'Paste Claude token',
    multiline: false,
  },
  codex: {
    title: 'Codex',
    fieldLabel: 'Auth JSON',
    hint: 'Paste the contents of ~/.codex/auth.json.',
    placeholder: '{"auth_mode":"chatgpt","tokens":{...}}',
    multiline: true,
  },
};

const providers: ProviderCredentialProvider[] = ['claude-code', 'codex'];

function disconnectedProviderStatus(provider: ProviderCredentialProvider): ProviderCredentialStatus {
  return {
    provider,
    connected: false,
    status: 'needs_auth',
    lastValidatedAt: null,
    lastError: null,
    updatedAt: null,
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function isMissingConnectionsEndpoint(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}

function githubConnectionLabel(tokenKind: ConnectionStatus['tokenKind']): string {
  switch (tokenKind) {
    case 'app_installation':
      return 'App installation';
    case 'app_user':
      return 'GitHub user';
    case 'pat':
      return 'PAT';
    case 'public_read':
      return 'Public';
    default:
      return 'GitHub';
  }
}

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
      <Text
        maxFontSizeMultiplier={2}
        style={{ color: colors.text, flexShrink: 1, fontSize: font.md, fontWeight: '700' }}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

function GitHubConnectionRow({
  status,
  loading,
  available,
  busy,
  onConnect,
  onDisconnect,
}: {
  status?: ConnectionStatus;
  loading: boolean;
  available: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { colors } = useTheme();
  const connected = status?.connected === true;
  const unavailable = !available || status?.status === 'unavailable';
  const statusLabel = loading
    ? 'Checking...'
    : unavailable
      ? 'Unavailable'
      : connected
        ? `${status.accountLabel ?? 'Connected'} · ${githubConnectionLabel(status.tokenKind)}`
        : status?.status === 'needs_auth'
          ? 'Needs auth'
          : 'Public read';
  const actionLabel = unavailable ? 'Unavailable' : connected ? 'Disconnect' : 'Connect';
  const disabled = loading || busy || unavailable;

  return (
    <Row label="GitHub">
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          flexShrink: 1,
          gap: space.sm,
          justifyContent: 'flex-end',
        }}
      >
        <View
          accessible
          accessibilityLabel={`GitHub ${statusLabel}`}
          style={{ alignItems: 'center', flexDirection: 'row', gap: 6, maxWidth: 154 }}
        >
          <View
            style={{
              backgroundColor: connected ? colors.online : unavailable ? colors.textFaint : colors.warning,
              borderRadius: 4,
              height: 8,
              opacity: connected ? 1 : 0.65,
              width: 8,
            }}
          />
          <Text
            maxFontSizeMultiplier={2}
            numberOfLines={1}
            style={{ color: connected ? colors.textSecondary : colors.textMuted, fontSize: font.sm }}
          >
            {statusLabel}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${actionLabel} GitHub`}
          accessibilityHint={
            unavailable
              ? 'GitHub connections are unavailable on this server'
              : connected
                ? 'Removes this GitHub connection'
                : 'Starts the GitHub connection flow'
          }
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => (connected ? onDisconnect() : onConnect())}
          style={({ pressed }) => ({
            alignItems: 'center',
            backgroundColor: connected || unavailable ? 'transparent' : colors.accent,
            borderColor: connected || unavailable ? colors.border : colors.accent,
            borderRadius: radius.md,
            borderWidth: 1,
            justifyContent: 'center',
            minHeight: 36,
            minWidth: 88,
            opacity: disabled ? 0.55 : pressed ? 0.85 : 1,
            paddingHorizontal: space.md,
          })}
        >
          {busy ? (
            <ActivityIndicator color={connected ? colors.textMuted : colors.onAccent} />
          ) : (
            <Text
              maxFontSizeMultiplier={2}
              numberOfLines={1}
              style={{
                color: connected || unavailable ? colors.textSecondary : colors.onAccent,
                fontSize: font.sm,
                fontWeight: '800',
              }}
            >
              {actionLabel}
            </Text>
          )}
        </Pressable>
      </View>
    </Row>
  );
}

function ProviderConnectionRow({
  provider,
  status,
  loading,
  busy,
  onConnect,
  onDisconnect,
}: {
  provider: ProviderCredentialProvider;
  status?: ProviderCredentialStatus;
  loading: boolean;
  busy: boolean;
  onConnect: (provider: ProviderCredentialProvider) => void;
  onDisconnect: (provider: ProviderCredentialProvider) => void;
}) {
  const { colors } = useTheme();
  const config = providerConfigs[provider];
  const connected = status?.connected === true;
  const statusLabel = loading ? 'Checking...' : connected ? 'Connected \u2713' : 'Not connected';
  const actionLabel = connected ? 'Disconnect' : 'Connect';

  return (
    <Row label={config.title}>
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          flexShrink: 1,
          gap: space.sm,
          justifyContent: 'flex-end',
        }}
      >
        <View
          accessible
          accessibilityLabel={`${config.title} ${statusLabel}`}
          style={{ alignItems: 'center', flexDirection: 'row', gap: 6, maxWidth: 126 }}
        >
          <View
            style={{
              backgroundColor: connected ? colors.online : colors.textFaint,
              borderRadius: 4,
              height: 8,
              opacity: connected ? 1 : 0.55,
              width: 8,
            }}
          />
          <Text
            maxFontSizeMultiplier={2}
            numberOfLines={1}
            style={{ color: connected ? colors.textSecondary : colors.textMuted, fontSize: font.sm }}
          >
            {statusLabel}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${actionLabel} ${config.title}`}
          accessibilityHint={connected ? 'Removes this provider connection' : 'Opens the provider connection sheet'}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => (connected ? onDisconnect(provider) : onConnect(provider))}
          style={({ pressed }) => ({
            alignItems: 'center',
            backgroundColor: connected ? 'transparent' : colors.accent,
            borderColor: connected ? colors.border : colors.accent,
            borderRadius: radius.md,
            borderWidth: 1,
            justifyContent: 'center',
            minHeight: 36,
            minWidth: 88,
            opacity: busy ? 0.55 : pressed ? 0.85 : 1,
            paddingHorizontal: space.md,
          })}
        >
          {busy ? (
            <ActivityIndicator color={connected ? colors.textMuted : colors.onAccent} />
          ) : (
            <Text
              maxFontSizeMultiplier={2}
              numberOfLines={1}
              style={{
                color: connected ? colors.textSecondary : colors.onAccent,
                fontSize: font.sm,
                fontWeight: '800',
              }}
            >
              {actionLabel}
            </Text>
          )}
        </Pressable>
      </View>
    </Row>
  );
}

function ConnectProviderSheet({
  provider,
  status,
  value,
  busy,
  error,
  onChangeValue,
  onClose,
  onDisconnect,
  onSubmit,
}: {
  provider: ProviderCredentialProvider | null;
  status?: ProviderCredentialStatus;
  value: string;
  busy: boolean;
  error: string | null;
  onChangeValue: (value: string) => void;
  onClose: () => void;
  onDisconnect: () => void;
  onSubmit: () => void;
}) {
  const { colors, reduceMotion } = useTheme();
  const titleRef = useRef<Text>(null);
  useModalAccessibilityFocus(titleRef, provider != null);
  useAccessibilityAnnouncement(error);

  if (!provider) return null;

  const config = providerConfigs[provider];
  const connected = status?.connected === true;
  const canSubmit = value.trim().length > 0 && !busy;

  return (
    <Modal visible transparent animationType={reduceMotion ? 'none' : 'slide'} onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' }}>
          <Pressable
            accessible={false}
            disabled={busy}
            onPress={onClose}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
          />
          <View
            accessibilityRole="summary"
            accessibilityLabel={`Connect ${config.title}`}
            accessibilityViewIsModal
            style={{
              backgroundColor: colors.bgElevated,
              borderColor: colors.border,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              borderWidth: 1,
              maxHeight: '82%',
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                alignItems: 'center',
                borderBottomColor: colors.border,
                borderBottomWidth: 1,
                flexDirection: 'row',
                minHeight: 56,
                paddingHorizontal: space.lg,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  ref={titleRef}
                  accessibilityRole="header"
                  maxFontSizeMultiplier={2}
                  style={{ color: colors.text, fontSize: font.md, fontWeight: '800' }}
                >
                  {config.title}
                </Text>
                <Text maxFontSizeMultiplier={2} style={{ color: colors.textMuted, fontSize: font.xs, marginTop: 2 }}>
                  {connected ? 'Connected' : 'Not connected'}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close provider connection sheet"
                disabled={busy}
                onPress={onClose}
                style={({ pressed }) => ({
                  borderRadius: radius.sm,
                  opacity: busy ? 0.4 : pressed ? 0.7 : 1,
                  paddingHorizontal: space.sm,
                  paddingVertical: space.sm,
                })}
              >
                <Text maxFontSizeMultiplier={2} style={{ color: colors.textMuted, fontSize: font.md }}>
                  Close
                </Text>
              </Pressable>
            </View>
            <ScrollView
              contentContainerStyle={{ gap: space.md, padding: space.lg }}
              keyboardShouldPersistTaps="handled"
            >
              <Text
                maxFontSizeMultiplier={2}
                style={{
                  backgroundColor: colors.bgInput,
                  borderColor: colors.borderSoft,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  color: colors.textMuted,
                  fontSize: font.sm,
                  lineHeight: 19,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                }}
              >
                {config.hint}
              </Text>
              <View>
                <Text
                  maxFontSizeMultiplier={2}
                  style={{
                    color: colors.textMuted,
                    fontSize: font.xs,
                    fontWeight: '800',
                    marginBottom: 6,
                    textTransform: 'uppercase',
                  }}
                >
                  {config.fieldLabel}
                </Text>
                <TextInput
                  accessibilityLabel={config.fieldLabel}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  multiline={config.multiline}
                  onChangeText={onChangeValue}
                  placeholder={config.placeholder}
                  placeholderTextColor={colors.textFaint}
                  secureTextEntry={!config.multiline}
                  spellCheck={false}
                  style={{
                    backgroundColor: colors.bgInput,
                    borderColor: colors.border,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    color: colors.text,
                    fontFamily: config.multiline ? (Platform.OS === 'ios' ? 'Menlo' : 'monospace') : undefined,
                    fontSize: config.multiline ? font.sm : font.md,
                    minHeight: config.multiline ? 148 : 48,
                    paddingHorizontal: space.md,
                    paddingVertical: 12,
                    textAlignVertical: config.multiline ? 'top' : 'center',
                  }}
                  value={value}
                />
              </View>
              {status?.lastError ? (
                <Text
                  accessibilityLiveRegion="polite"
                  maxFontSizeMultiplier={2}
                  style={{
                    backgroundColor: colors.warningSurface,
                    borderColor: colors.warningBorder,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    color: colors.warning,
                    fontSize: font.sm,
                    paddingHorizontal: space.md,
                    paddingVertical: space.sm,
                  }}
                >
                  {status.lastError}
                </Text>
              ) : null}
              {error ? (
                <Text
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  maxFontSizeMultiplier={2}
                  style={{
                    backgroundColor: colors.dangerSurface,
                    borderColor: colors.dangerBorder,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    color: colors.danger,
                    fontSize: font.sm,
                    paddingHorizontal: space.md,
                    paddingVertical: space.sm,
                  }}
                >
                  {error}
                </Text>
              ) : null}
            </ScrollView>
            <View
              style={{
                alignItems: 'center',
                borderTopColor: colors.border,
                borderTopWidth: 1,
                flexDirection: 'row',
                justifyContent: 'space-between',
                gap: space.sm,
                padding: space.lg,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Disconnect ${config.title}`}
                accessibilityHint="Removes this provider connection"
                accessibilityState={{ disabled: !connected || busy }}
                disabled={!connected || busy}
                onPress={onDisconnect}
                style={({ pressed }) => ({
                  borderRadius: radius.md,
                  opacity: !connected || busy ? 0.35 : pressed ? 0.75 : 1,
                  paddingHorizontal: space.sm,
                  paddingVertical: space.sm,
                })}
              >
                <Text
                  maxFontSizeMultiplier={2}
                  style={{ color: colors.textMuted, fontSize: font.sm, fontWeight: '700' }}
                >
                  Disconnect
                </Text>
              </Pressable>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel provider connection"
                  disabled={busy}
                  onPress={onClose}
                  style={({ pressed }) => ({
                    alignItems: 'center',
                    borderRadius: radius.md,
                    justifyContent: 'center',
                    minHeight: 42,
                    opacity: busy ? 0.45 : pressed ? 0.75 : 1,
                    paddingHorizontal: space.md,
                  })}
                >
                  <Text
                    maxFontSizeMultiplier={2}
                    style={{ color: colors.textSecondary, fontSize: font.sm, fontWeight: '800' }}
                  >
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${connected ? 'Reconnect' : 'Connect'} ${config.title}`}
                  accessibilityHint={connected ? 'Replaces this provider credential' : 'Saves this provider credential'}
                  accessibilityState={{ disabled: !canSubmit }}
                  disabled={!canSubmit}
                  onPress={onSubmit}
                  style={({ pressed }) => ({
                    alignItems: 'center',
                    backgroundColor: canSubmit ? colors.accent : colors.bgInput,
                    borderRadius: radius.md,
                    justifyContent: 'center',
                    minHeight: 42,
                    minWidth: 104,
                    opacity: pressed ? 0.85 : 1,
                    paddingHorizontal: space.md,
                  })}
                >
                  {busy ? (
                    <ActivityIndicator color={colors.onAccent} />
                  ) : (
                    <Text
                      maxFontSizeMultiplier={2}
                      numberOfLines={1}
                      style={{
                        color: canSubmit ? colors.onAccent : colors.textFaint,
                        fontSize: font.sm,
                        fontWeight: '800',
                      }}
                    >
                      {connected ? 'Reconnect' : 'Connect'}
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
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
  const [providerCredentials, setProviderCredentials] = useState<
    Partial<Record<ProviderCredentialProvider, ProviderCredentialStatus>>
  >({});
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providerStatusError, setProviderStatusError] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<ProviderCredentialProvider | null>(null);
  const [credential, setCredential] = useState('');
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [pendingProvider, setPendingProvider] = useState<ProviderCredentialProvider | null>(null);
  const [githubConnection, setGithubConnection] = useState<ConnectionStatus | undefined>();
  const [connectionsAvailable, setConnectionsAvailable] = useState(true);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [devicePushEnabled, setDevicePushEnabledState] = useState<boolean | null>(null);
  const [pushPermission, setPushPermission] = useState<PushPermissionStatus>('undetermined');
  const [pushBusy, setPushBusy] = useState(false);

  useAccessibilityAnnouncement(providerStatusError ?? connectionsError);

  useEffect(() => {
    let mounted = true;
    void Promise.all([loadDevicePushEnabled(), getPushPermissionStatus()])
      .then(([enabled, permission]) => {
        if (!mounted) return;
        setDevicePushEnabledState(enabled);
        setPushPermission(permission);
      })
      .catch((err: unknown) => {
        console.warn('failed to load push notification setting', err);
        if (mounted) setDevicePushEnabledState(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const updateNotificationPrefs = useCallback(
    (patch: Partial<NotificationPrefs>) => {
      setPrefs((prev) => ({
        ...prev,
        notifications: {
          messages: patch.messages ?? prev.notifications.messages,
          sessions: patch.sessions ?? prev.notifications.sessions,
          calls: patch.calls ?? prev.notifications.calls,
        },
      }));
    },
    [setPrefs],
  );

  const updateDevicePush = useCallback(
    (enabled: boolean) => {
      if (pushBusy) return;
      setPushBusy(true);
      setDevicePushEnabledState(enabled);
      void (async () => {
        await setDevicePushEnabled(enabled);
        if (enabled) {
          await registerForPush(api);
          const permission = await getPushPermissionStatus();
          setPushPermission(permission);
          if (permission === 'denied') {
            await setDevicePushEnabled(false);
            setDevicePushEnabledState(false);
          }
          return;
        }
        await unregisterPush(api, getRegisteredPushToken());
        setPushPermission(await getPushPermissionStatus());
      })()
        .catch((err: unknown) => {
          console.warn('failed to update push notification setting', err);
        })
        .finally(() => {
          setPushBusy(false);
        });
    },
    [api, pushBusy],
  );

  const loadProviderCredentials = useCallback(async () => {
    setProvidersLoading(true);
    setProviderStatusError(null);
    try {
      const { providers: nextProviders } = await api.providerCredentials();
      setProviderCredentials(
        Object.fromEntries(nextProviders.map((provider) => [provider.provider, provider])) as Partial<
          Record<ProviderCredentialProvider, ProviderCredentialStatus>
        >,
      );
    } catch (err) {
      setProviderStatusError(errorMessage(err, 'Could not load provider connections.'));
    } finally {
      setProvidersLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadProviderCredentials();
  }, [loadProviderCredentials]);

  const loadConnections = useCallback(async () => {
    setConnectionsLoading(true);
    setConnectionsError(null);
    try {
      const { connections } = await api.connections();
      setGithubConnection(connections.find((connection) => connection.provider === 'github'));
      setConnectionsAvailable(true);
    } catch (err) {
      if (isMissingConnectionsEndpoint(err)) {
        setGithubConnection(undefined);
        setConnectionsAvailable(false);
      } else {
        setConnectionsError(errorMessage(err, 'Could not load GitHub connection.'));
      }
    } finally {
      setConnectionsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const openProviderSheet = useCallback((provider: ProviderCredentialProvider) => {
    setActiveProvider(provider);
    setCredential('');
    setCredentialError(null);
  }, []);

  const closeProviderSheet = useCallback(() => {
    if (pendingProvider) return;
    setActiveProvider(null);
    setCredential('');
    setCredentialError(null);
  }, [pendingProvider]);

  const disconnectProvider = useCallback(
    async (provider: ProviderCredentialProvider, closeOnSuccess = false) => {
      if (pendingProvider) return;
      setPendingProvider(provider);
      setProviderStatusError(null);
      if (closeOnSuccess) setCredentialError(null);
      try {
        if (provider === 'claude-code') {
          await api.disconnectClaudeCode();
        } else {
          await api.disconnectCodex();
        }
        setProviderCredentials((prev) => ({
          ...prev,
          [provider]: disconnectedProviderStatus(provider),
        }));
        if (closeOnSuccess) {
          setActiveProvider(null);
          setCredential('');
        }
      } catch (err) {
        const message = errorMessage(err, `Could not disconnect ${providerConfigs[provider].title}.`);
        if (closeOnSuccess) {
          setCredentialError(message);
        } else {
          setProviderStatusError(message);
        }
      } finally {
        setPendingProvider(null);
      }
    },
    [api, pendingProvider],
  );

  const submitProviderCredential = useCallback(async () => {
    if (!activeProvider || pendingProvider) return;
    const nextCredential = credential.trim();
    if (!nextCredential) return;
    setPendingProvider(activeProvider);
    setCredentialError(null);
    setProviderStatusError(null);
    try {
      const { provider } =
        activeProvider === 'claude-code'
          ? await api.connectClaudeCode(nextCredential)
          : await api.connectCodex(nextCredential);
      setProviderCredentials((prev) => ({ ...prev, [provider.provider]: provider }));
      await loadProviderCredentials();
      setActiveProvider(null);
      setCredential('');
    } catch (err) {
      setCredentialError(errorMessage(err, `Could not connect ${providerConfigs[activeProvider].title}.`));
    } finally {
      setPendingProvider(null);
    }
  }, [activeProvider, api, credential, loadProviderCredentials, pendingProvider]);

  const connectGitHub = useCallback(async () => {
    if (githubBusy || !connectionsAvailable || githubConnection?.status === 'unavailable') return;
    setGithubBusy(true);
    setConnectionsError(null);
    try {
      const { connection, authorizeUrl } = await api.connectGitHub();
      setConnectionsAvailable(true);
      setGithubConnection(connection);
      if (authorizeUrl) {
        await Linking.openURL(authorizeUrl);
        return;
      }
      await loadConnections();
    } catch (err) {
      if (isMissingConnectionsEndpoint(err)) {
        setGithubConnection(undefined);
        setConnectionsAvailable(false);
        return;
      }
      setConnectionsError(errorMessage(err, 'Could not connect GitHub.'));
    } finally {
      setGithubBusy(false);
    }
  }, [api, connectionsAvailable, githubBusy, githubConnection?.status, loadConnections]);

  const disconnectGitHub = useCallback(async () => {
    if (githubBusy || !connectionsAvailable || githubConnection?.status === 'unavailable') return;
    setGithubBusy(true);
    setConnectionsError(null);
    try {
      const { connection } = await api.disconnectGitHub();
      setGithubConnection(connection);
      setConnectionsAvailable(true);
    } catch (err) {
      if (isMissingConnectionsEndpoint(err)) {
        setGithubConnection(undefined);
        setConnectionsAvailable(false);
        return;
      }
      setConnectionsError(errorMessage(err, 'Could not disconnect GitHub.'));
    } finally {
      setGithubBusy(false);
    }
  }, [api, connectionsAvailable, githubBusy, githubConnection?.status]);

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

        <SectionLabel>Connections</SectionLabel>
        <GitHubConnectionRow
          status={githubConnection}
          loading={connectionsLoading}
          available={connectionsAvailable}
          busy={githubBusy}
          onConnect={() => void connectGitHub()}
          onDisconnect={() => void disconnectGitHub()}
        />
        {providers.map((provider) => (
          <ProviderConnectionRow
            key={provider}
            provider={provider}
            status={providerCredentials[provider]}
            loading={providersLoading}
            busy={pendingProvider === provider}
            onConnect={openProviderSheet}
            onDisconnect={disconnectProvider}
          />
        ))}
        {providerStatusError ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            maxFontSizeMultiplier={2}
            style={{
              color: colors.danger,
              fontSize: font.sm,
              paddingHorizontal: space.lg,
              paddingTop: space.sm,
            }}
          >
            {providerStatusError}
          </Text>
        ) : null}
        {connectionsError ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            maxFontSizeMultiplier={2}
            style={{
              color: colors.danger,
              fontSize: font.sm,
              paddingHorizontal: space.lg,
              paddingTop: space.sm,
            }}
          >
            {connectionsError}
          </Text>
        ) : null}

        <SectionLabel>Notifications</SectionLabel>
        <Row label="Push notifications">
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel="Push notifications"
              accessibilityState={{
                checked: devicePushEnabled === true && pushPermission !== 'denied',
                disabled: devicePushEnabled == null || pushBusy || pushPermission === 'denied',
              }}
              disabled={devicePushEnabled == null || pushBusy || pushPermission === 'denied'}
              value={devicePushEnabled === true && pushPermission !== 'denied'}
              onValueChange={updateDevicePush}
              trackColor={{ false: colors.switchTrackOff, true: colors.accent }}
              thumbColor={
                devicePushEnabled === true && pushPermission !== 'denied' ? colors.onAccent : colors.switchThumbOff
              }
            />
            {pushPermission === 'denied' ? (
              <Text maxFontSizeMultiplier={2} style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '600' }}>
                Enable in system settings
              </Text>
            ) : null}
          </View>
        </Row>
        <Row label="Messages">
          <Segmented
            value={prefs.notifications.messages}
            options={messageNotificationOptions}
            label="Message notifications"
            onChange={(messages) => updateNotificationPrefs({ messages })}
          />
        </Row>
        <Row label="Agents">
          <Switch
            accessibilityRole="switch"
            accessibilityLabel="Agent notifications"
            accessibilityState={{ checked: prefs.notifications.sessions }}
            value={prefs.notifications.sessions}
            onValueChange={(sessions) => updateNotificationPrefs({ sessions })}
            trackColor={{ false: colors.switchTrackOff, true: colors.accent }}
            thumbColor={prefs.notifications.sessions ? colors.onAccent : colors.switchThumbOff}
          />
        </Row>
        <Row label="Calls">
          <Switch
            accessibilityRole="switch"
            accessibilityLabel="Call notifications"
            accessibilityState={{ checked: prefs.notifications.calls }}
            value={prefs.notifications.calls}
            onValueChange={(calls) => updateNotificationPrefs({ calls })}
            trackColor={{ false: colors.switchTrackOff, true: colors.accent }}
            thumbColor={prefs.notifications.calls ? colors.onAccent : colors.switchThumbOff}
          />
        </Row>

        <SectionLabel>Account</SectionLabel>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log out"
          accessibilityHint="Signs out of this Atrium server"
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
      <ConnectProviderSheet
        provider={activeProvider}
        status={activeProvider ? providerCredentials[activeProvider] : undefined}
        value={credential}
        busy={activeProvider != null && pendingProvider === activeProvider}
        error={credentialError}
        onChangeValue={setCredential}
        onClose={closeProviderSheet}
        onDisconnect={() => {
          if (activeProvider) void disconnectProvider(activeProvider, true);
        }}
        onSubmit={() => {
          void submitProviderCredential();
        }}
      />
    </View>
  );
}
