import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Api, UserRef, WireEvent } from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../lib/theme';

export interface EntryCommentsProps {
  api: Api;
  handle: string | null;
  visible: boolean;
  me: UserRef;
  onClose: () => void;
}

export function EntryComments({ api, handle, visible, me, onClose }: EntryCommentsProps) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const [comments, setComments] = useState<WireEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);

  useEffect(() => {
    if (!visible || !handle) return;
    let cancelled = false;
    setComments([]);
    setLoading(true);
    setLoadFailed(false);
    setSendFailed(false);
    setDraft('');
    void api
      .getEntryAnnotations(handle)
      .then(({ comments: nextComments }) => {
        if (!cancelled) setComments(nextComments);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, handle, visible]);

  const send = () => {
    if (!handle) return;
    const text = draft.trim();
    if (!text || sending) return;
    const optimistic: WireEvent = {
      id: -Date.now(),
      workspaceId: '',
      channelId: null,
      threadRootEventId: null,
      type: 'comment.posted',
      actorId: me.id,
      payload: { target: handle, text },
      createdAt: new Date().toISOString(),
      author: me,
    };
    setComments((prev) => [...prev, optimistic]);
    setDraft('');
    setSending(true);
    setSendFailed(false);
    void api
      .postEntryComment(handle, text)
      .then(({ event }) => {
        setComments((prev) =>
          prev.map((comment) => (comment.id === optimistic.id ? event : comment)),
        );
      })
      .catch(() => {
        setComments((prev) => prev.filter((comment) => comment.id !== optimistic.id));
        setDraft(text);
        setSendFailed(true);
      })
      .finally(() => setSending(false));
  };

  const showSheet = visible && handle != null;
  const sendDisabled = sending || draft.trim().length === 0;

  return (
    <Modal
      visible={showSheet}
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close comments"
        onPress={onClose}
        style={{ flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' }}
      >
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable
            onPress={() => {}}
            style={{
              maxHeight: '82%',
              backgroundColor: colors.bgElevated,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              paddingBottom: insets.bottom + space.sm,
            }}
          >
            <View
              style={{
                minHeight: 52,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: space.lg,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }}>
                Comments
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close comments"
                onPress={onClose}
                hitSlop={8}
                style={{
                  width: 44,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                gap: space.sm,
                paddingHorizontal: space.lg,
                paddingVertical: space.md,
              }}
              style={{ maxHeight: 320 }}
            >
              {loading && comments.length === 0 ? (
                <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.xl }}>
                  <ActivityIndicator color={colors.textMuted} />
                  <Text style={{ color: colors.textMuted, fontSize: font.sm }}>
                    Loading comments...
                  </Text>
                </View>
              ) : comments.length === 0 ? (
                <Text
                  style={{
                    color: colors.textMuted,
                    fontSize: font.sm,
                    textAlign: 'center',
                    paddingVertical: space.xl,
                  }}
                >
                  No comments yet.
                </Text>
              ) : (
                comments.map((comment) => <CommentRow key={String(comment.id)} comment={comment} />)
              )}
              {loadFailed ? (
                <Text
                  accessibilityRole="alert"
                  style={{
                    color: colors.warning,
                    fontSize: font.xs,
                    borderWidth: 1,
                    borderColor: colors.warningBorder,
                    backgroundColor: colors.warningSurface,
                    borderRadius: radius.sm,
                    paddingHorizontal: space.sm,
                    paddingVertical: space.sm,
                  }}
                >
                  Couldn't load comments.
                </Text>
              ) : null}
            </ScrollView>

            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: colors.border,
                paddingHorizontal: space.lg,
                paddingTop: space.md,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
                <TextInput
                  value={draft}
                  editable={!sending}
                  multiline
                  onChangeText={setDraft}
                  placeholder="Add a comment"
                  placeholderTextColor={colors.textFaint}
                  accessibilityLabel="Comment text"
                  style={{
                    flex: 1,
                    minHeight: 72,
                    maxHeight: 132,
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderRadius: radius.md,
                    backgroundColor: colors.bgInput,
                    color: colors.text,
                    fontSize: font.md,
                    lineHeight: 20,
                    paddingHorizontal: space.md,
                    paddingTop: space.sm,
                    paddingBottom: space.sm,
                    textAlignVertical: 'top',
                  }}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Send comment"
                  disabled={sendDisabled}
                  onPress={send}
                  style={({ pressed }) => ({
                    minHeight: 44,
                    minWidth: 64,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radius.md,
                    paddingHorizontal: space.md,
                    backgroundColor: sendDisabled
                      ? colors.bgPressed
                      : pressed
                        ? colors.accentBg
                        : colors.accent,
                    opacity: sendDisabled ? 0.7 : 1,
                  })}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={colors.textMuted} />
                  ) : (
                    <Text
                      style={{
                        color: sendDisabled ? colors.textMuted : colors.onAccent,
                        fontSize: font.sm,
                        fontWeight: '700',
                      }}
                    >
                      Send
                    </Text>
                  )}
                </Pressable>
              </View>
              {sendFailed ? (
                <Text accessibilityRole="alert" style={{ color: colors.warning, fontSize: font.xs, marginTop: 6 }}>
                  Couldn't send comment.
                </Text>
              ) : null}
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

function CommentRow({ comment }: { comment: WireEvent }) {
  const { colors } = useTheme();
  const { text, deleted } = commentPayload(comment);
  const author = comment.author;
  const displayName = author?.displayName ?? author?.handle ?? 'Unknown';
  const handleLabel = author?.handle && author.handle !== displayName ? author.handle : null;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        backgroundColor: colors.bg,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, color: colors.text, fontSize: font.sm, fontWeight: '700' }}
        >
          {displayName}
        </Text>
        {handleLabel ? (
          <Text
            numberOfLines={1}
            style={{ flexShrink: 1, color: colors.textMuted, fontSize: font.xs }}
          >
            @{handleLabel}
          </Text>
        ) : null}
        <Text
          style={{
            marginLeft: 'auto',
            color: colors.textMuted,
            fontSize: font.xs,
            fontVariant: ['tabular-nums'],
          }}
        >
          {relativeTime(comment.createdAt)}
        </Text>
      </View>
      <Text
        selectable={!deleted}
        style={{
          color: deleted ? colors.textMuted : colors.textSecondary,
          fontSize: font.sm,
          lineHeight: 19,
          fontStyle: deleted ? 'italic' : 'normal',
        }}
      >
        {deleted ? 'Comment deleted' : text}
      </Text>
    </View>
  );
}

function commentPayload(comment: WireEvent): { text: string; deleted: boolean } {
  const payload = comment.payload ?? {};
  const raw = comment as WireEvent & { text?: unknown; deleted?: unknown };
  return {
    text:
      typeof payload.text === 'string'
        ? payload.text
        : typeof raw.text === 'string'
          ? raw.text
          : '',
    deleted: payload.deleted === true || raw.deleted === true,
  };
}

function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const elapsed = Date.now() - ts;
  if (elapsed < 45_000) return 'just now';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < hour) return `${Math.round(elapsed / minute)}m ago`;
  if (elapsed < day) return `${Math.round(elapsed / hour)}h ago`;
  if (elapsed < 7 * day) return `${Math.round(elapsed / day)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
