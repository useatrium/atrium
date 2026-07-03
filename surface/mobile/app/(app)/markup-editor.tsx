import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useChat } from '../../src/lib/chat';
import { font, radius, space, useTheme } from '../../src/lib/theme';
import {
  buildMarkupShellUrl,
  clearPendingMarkupDraft,
  getPendingMarkupDraft,
  markupErrorMessage,
  parseMarkupWebViewMessage,
  submitMarkupDraft,
} from '../../src/lib/markupAuthoring';

export default function MarkupEditorScreen() {
  const { draftId } = useLocalSearchParams<{ draftId?: string }>();
  const draft = useMemo(() => (draftId ? getPendingMarkupDraft(draftId) : null), [draftId]);
  const webViewRef = useRef<WebView | null>(null);
  const chat = useChat();
  const { colors, scheme } = useTheme();
  const headerHeight = useHeaderHeight();
  const [shellReady, setShellReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitingForSerialize, setWaitingForSerialize] = useState(false);
  const hasUnsavedWork = dirty || note.trim().length > 0;
  const isReplyMode = draft?.mode.kind === 'reply';

  const requestClose = useCallback(() => {
    if (!hasUnsavedWork) {
      router.back();
      return;
    }
    Alert.alert('Discard markup?', 'Your markup and note will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  }, [hasUnsavedWork]);

  useFocusEffect(
    useCallback(() => {
      const handler = (BackHandler as unknown as {
        addEventListener?: (
          eventName: 'hardwareBackPress',
          handler: () => boolean,
        ) => { remove: () => void };
      }).addEventListener?.('hardwareBackPress', () => {
        requestClose();
        return true;
      });
      return () => handler?.remove();
    }, [requestClose]),
  );

  const postToShell = useCallback((message: unknown) => {
    webViewRef.current?.postMessage(JSON.stringify(message));
  }, []);

  const initShell = useCallback(() => {
    if (!draft) return;
    setShellReady(true);
    postToShell({
      type: 'markup-init',
      markdown: draft.body,
      commentAuthor: chat.me.handle,
    });
  }, [chat.me.handle, draft, postToShell]);

  const handleSerialized = useCallback(
    async (markdown: string) => {
      if (!draft) return;
      setWaitingForSerialize(false);
      setSending(true);
      setError(null);
      try {
        const sentMode = await submitMarkupDraft({
          api: chat.api,
          serverUrl: chat.serverUrl,
          draft,
          markdown,
          note,
        });
        if (draftId) clearPendingMarkupDraft(draftId);
        if (sentMode === 'reply' && draft.mode.kind === 'reply') {
          router.replace({
            pathname: '/thread/[rootId]',
            params: {
              rootId: String(draft.mode.threadRootEventId),
              channelId: draft.mode.channelId,
            },
          });
        } else {
          router.back();
        }
      } catch (err) {
        setError(markupErrorMessage(err));
      } finally {
        setSending(false);
      }
    },
    [chat.api, chat.serverUrl, draft, draftId, note],
  );

  const handleWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseMarkupWebViewMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === 'markup-shell-ready') {
        initShell();
      } else if (message.type === 'markup-dirty') {
        setDirty(message.dirty);
      } else if (message.type === 'markup-serialized' && waitingForSerialize) {
        void handleSerialized(message.markdown);
      }
    },
    [handleSerialized, initShell, waitingForSerialize],
  );

  const requestSend = useCallback(() => {
    if (!draft || sending || waitingForSerialize || (!dirty && note.trim().length === 0)) return;
    setWaitingForSerialize(true);
    postToShell({ type: 'markup-request-serialize' });
  }, [dirty, draft, note, postToShell, sending, waitingForSerialize]);

  if (!draft) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, padding: space.xl }}>
        <Stack.Screen options={{ title: 'Markup', headerBackButtonDisplayMode: 'minimal' }} />
        <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
          Markup draft is no longer available.
        </Text>
      </View>
    );
  }

  const canSend = shellReady && !sending && !waitingForSerialize && (dirty || note.trim().length > 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          title: isReplyMode ? 'Mark up & reply' : 'Mark up & send',
          headerBackVisible: false,
          gestureEnabled: !hasUnsavedWork,
          headerLeft: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close markup editor"
              onPress={requestClose}
              hitSlop={8}
              style={{ minHeight: 44, justifyContent: 'center', paddingRight: space.md }}
            >
              <Text style={{ color: colors.textSecondary, fontSize: font.md }}>Cancel</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isReplyMode ? 'Reply in thread' : 'Send to agent'}
              disabled={!canSend}
              onPress={requestSend}
              hitSlop={8}
              style={{
                minHeight: 44,
                justifyContent: 'center',
                opacity: canSend ? 1 : 0.45,
              }}
            >
              <Text style={{ color: colors.accent, fontSize: font.md, fontWeight: '700' }}>
                {sending || waitingForSerialize ? 'Sending...' : isReplyMode ? 'Reply in thread' : 'Send to agent'}
              </Text>
            </Pressable>
          ),
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={headerHeight}
      >
        {error ? (
          <View style={{ borderBottomWidth: 1, borderBottomColor: colors.dangerBorder, backgroundColor: colors.dangerSurface, padding: space.md }}>
            <Text style={{ color: colors.danger, fontSize: font.sm }}>{error}</Text>
          </View>
        ) : null}
        <View style={{ flex: 1, minHeight: 0 }}>
          {!shellReady ? (
            <View
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1,
              }}
            >
              <ActivityIndicator color={colors.textMuted} />
            </View>
          ) : null}
          <WebView
            ref={webViewRef}
            source={{ uri: buildMarkupShellUrl(chat.serverUrl, scheme) }}
            onMessage={handleWebViewMessage}
            javaScriptEnabled
            originWhitelist={[chat.serverUrl, `${chat.serverUrl}/*`]}
            startInLoadingState
            style={{ flex: 1, backgroundColor: colors.bg }}
          />
        </View>
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.bgElevated,
            padding: space.md,
            gap: space.sm,
          }}
        >
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={isReplyMode ? 'Say something about your changes...' : 'Add a note...'}
            placeholderTextColor={colors.textFaint}
            returnKeyType="default"
            multiline
            style={{
              minHeight: 44,
              maxHeight: 120,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.sm,
              backgroundColor: colors.bgInput,
              color: colors.text,
              fontSize: font.md,
              paddingHorizontal: space.md,
              paddingVertical: 10,
            }}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
