// Long-press action sheet for a message: quick reactions + reply/edit/delete.

import { useEffect, useRef, useState, type Ref } from 'react';
import { Alert, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import type { ChatMessage } from '@atrium/surface-client';
import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '../lib/accessibility';
import { font, radius, space, useTheme } from '../lib/theme';
import { selectionHaptic } from '../lib/haptics';

const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🔥', '😢', '🚀', '🙏', '💯', '🤔'];

type MessageActionMetadata = {
  actionCopyText?: unknown;
  actionCopyLink?: unknown;
};

export interface MessageActionsProps {
  message: ChatMessage | null;
  mine: boolean;
  canReply: boolean;
  canMarkupReply?: boolean;
  onClose: () => void;
  onReact: (m: ChatMessage, emoji: string) => void;
  onReply: (m: ChatMessage) => void;
  onMarkupReply?: (m: ChatMessage) => void;
  onEdit: (m: ChatMessage) => void;
  onDelete: (m: ChatMessage) => void;
}

function Action({
  label,
  hint,
  destructive,
  focusRef,
  onPress,
}: {
  label: string;
  hint?: string;
  destructive?: boolean;
  focusRef?: Ref<View>;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      ref={focusRef}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: 'center',
        paddingVertical: 13,
        paddingHorizontal: space.lg,
        backgroundColor: pressed ? colors.bgPressed : 'transparent',
      })}
    >
      <Text
        style={{
          color: destructive ? colors.danger : colors.text,
          fontSize: font.md,
          fontWeight: '500',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function MessageActions({
  message,
  mine,
  canReply,
  canMarkupReply = false,
  onClose,
  onReact,
  onReply,
  onMarkupReply,
  onEdit,
  onDelete,
}: MessageActionsProps) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const firstActionRef = useRef<View>(null);
  const closeAfterCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const m = message;
  const deleted = m?.deleted === true;
  const confirmed = !deleted && m?.status === 'confirmed' && m.id != null;
  const sessionBlock = m?.sessionId != null || m?.sessionEventType != null;
  const rawCopyText =
    m == null
      ? ''
      : typeof (m as MessageActionMetadata).actionCopyText === 'string'
        ? ((m as MessageActionMetadata).actionCopyText as string)
        : m.text;
  const copyText = !deleted && rawCopyText.trim() ? rawCopyText : null;
  const rawCopyLink =
    m == null || typeof (m as MessageActionMetadata).actionCopyLink !== 'string'
      ? ''
      : ((m as MessageActionMetadata).actionCopyLink as string);
  const copyLink = !deleted && rawCopyLink.trim() ? rawCopyLink : null;
  const canReact = confirmed && !sessionBlock;
  const canReplyAction = confirmed && canReply && !sessionBlock;
  const canMarkupReplyAction = confirmed && canMarkupReply && !sessionBlock && onMarkupReply != null;
  const canMutateMessage = confirmed && mine && !sessionBlock;
  const focusReply = !canReact && canReplyAction;
  const focusMarkupReply = !canReact && !canReplyAction && canMarkupReplyAction;
  const focusCopyText = !canReact && !canReplyAction && !canMarkupReplyAction && copyText != null;
  const focusCopyLink =
    !canReact && !canReplyAction && !canMarkupReplyAction && copyText == null && copyLink != null;
  const focusEdit =
    !canReact &&
    !canReplyAction &&
    !canMarkupReplyAction &&
    copyText == null &&
    copyLink == null &&
    canMutateMessage;
  const focusCancel =
    !canReact &&
    !canReplyAction &&
    !canMarkupReplyAction &&
    copyText == null &&
    copyLink == null &&
    !canMutateMessage;

  useModalAccessibilityFocus(firstActionRef, m != null);
  useAccessibilityAnnouncement(
    copied ? 'Message text copied.' : copiedLink ? 'Message link copied.' : null,
  );

  useEffect(() => {
    setCopied(false);
    setCopiedLink(false);
    if (closeAfterCopyTimer.current) {
      clearTimeout(closeAfterCopyTimer.current);
      closeAfterCopyTimer.current = null;
    }
  }, [m]);

  useEffect(() => {
    return () => {
      if (closeAfterCopyTimer.current) clearTimeout(closeAfterCopyTimer.current);
    };
  }, []);

  const closeAfterCopy = () => {
    if (closeAfterCopyTimer.current) clearTimeout(closeAfterCopyTimer.current);
    closeAfterCopyTimer.current = setTimeout(() => {
      closeAfterCopyTimer.current = null;
      setCopied(false);
      setCopiedLink(false);
      onClose();
    }, 700);
  };

  return (
    <Modal visible={m != null} transparent animationType={reduceMotion ? 'none' : 'fade'} onRequestClose={onClose}>
      <Pressable
        // Scrim: tap-to-dismiss for sighted users. It must NOT be an accessibility
        // element — a labelled, role="button" container collapses into a single a11y
        // node on iOS and HIDES all its children (the reactions + actions) from
        // VoiceOver and from UI test drivers. VoiceOver users close via "Cancel" below.
        accessible={false}
        importantForAccessibility="no"
        style={{ flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' }}
        onPress={onClose}
      >
        <Pressable
          // Inner sheet only exists to swallow taps (so they don't hit the scrim).
          // Same a11y rule as the scrim: it must not be an accessibility element, or
          // it collapses every action into one combined node instead of exposing the
          // individual reaction/action buttons.
          accessible={false}
          accessibilityViewIsModal
          onPress={() => {}}
          style={{
            backgroundColor: colors.bgElevated,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            paddingBottom: insets.bottom + 8,
            paddingTop: space.md,
          }}
        >
          {m && canReact && (
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: space.sm,
                paddingHorizontal: space.lg,
                paddingBottom: space.md,
              }}
            >
              {QUICK_EMOJI.map((e, index) => (
                <Pressable
                  ref={index === 0 ? firstActionRef : undefined}
                  key={e}
                  accessibilityRole="button"
                  accessibilityLabel={`React with ${e}`}
                  accessibilityHint="Adds this reaction to the message"
                  onPress={() => {
                    selectionHaptic();
                    onReact(m, e);
                    onClose();
                  }}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: pressed ? colors.bgPressed : colors.bgInput,
                    alignItems: 'center',
                    justifyContent: 'center',
                  })}
                >
                  <Text style={{ fontSize: 22 }}>{e}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <View style={{ height: 1, backgroundColor: colors.border }} />
          {m && canReplyAction && (
            <Action
              label="Reply in thread"
              hint="Opens the thread for this message"
              focusRef={focusReply ? firstActionRef : undefined}
              onPress={() => {
                onReply(m);
                onClose();
              }}
            />
          )}
          {m && canMarkupReplyAction && (
            <Action
              label="Mark up & reply"
              hint="Starts a markup reply from this message"
              focusRef={focusMarkupReply ? firstActionRef : undefined}
              onPress={() => {
                onMarkupReply(m);
                onClose();
              }}
            />
          )}
          {m && copyText && (
            <Action
              label={copied ? 'Copied' : 'Copy text'}
              hint="Copies the message text to the clipboard"
              focusRef={focusCopyText ? firstActionRef : undefined}
              onPress={() => {
                selectionHaptic();
                void Clipboard.setStringAsync(copyText)
                  .then(() => {
                    setCopied(true);
                    closeAfterCopy();
                  })
                  .catch(() => onClose());
              }}
            />
          )}
          {m && copyLink && (
            <Action
              label={copiedLink ? 'Copied link' : 'Copy link'}
              hint="Copies a link to this message to the clipboard"
              focusRef={focusCopyLink ? firstActionRef : undefined}
              onPress={() => {
                selectionHaptic();
                void Clipboard.setStringAsync(copyLink)
                  .then(() => {
                    setCopiedLink(true);
                    closeAfterCopy();
                  })
                  .catch(() => onClose());
              }}
            />
          )}
          {m && canMutateMessage && (
            <Action
              label="Edit message"
              hint="Opens this message for editing"
              focusRef={focusEdit ? firstActionRef : undefined}
              onPress={() => {
                onEdit(m);
                onClose();
              }}
            />
          )}
          {m && canMutateMessage && (
            <Action
              label="Delete message"
              hint="Opens a confirmation before deleting this message"
              destructive
              onPress={() => {
                onClose();
                Alert.alert('Delete message?', 'This cannot be undone.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => onDelete(m) },
                ]);
              }}
            />
          )}
          <Action
            label="Cancel"
            hint="Closes the action menu"
            focusRef={focusCancel ? firstActionRef : undefined}
            onPress={onClose}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
