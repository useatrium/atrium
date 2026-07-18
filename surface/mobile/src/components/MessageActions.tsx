// Long-press action sheet: optional quick reactions + a data-driven action list.

import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type Ref } from 'react';
import { Alert, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import type { ChatMessage } from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';
import { QUICK_REACTIONS } from '@atrium/surface-client/reactions';
import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '../lib/accessibility';
import { font, radius, space, useTheme } from '../lib/theme';
import { selectionHaptic } from '../lib/haptics';
import { ReactionPickerBody } from './ReactionPickerSheet';

type MessageActionMetadata = {
  actionCopyText?: unknown;
  actionCopyLink?: unknown;
};

const AGENT_ANCHOR_SNIPPET_LENGTH = 40;

export function agentAnchorLabel(message: ChatMessage & { id: number }): string {
  const text = message.text.replace(/\s+/g, ' ').trim();
  if (!text) return `/e/${encodeEventHandle(message.id)}`;
  const snippet =
    text.length <= AGENT_ANCHOR_SNIPPET_LENGTH ? text : `${text.slice(0, AGENT_ANCHOR_SNIPPET_LENGTH - 1).trimEnd()}…`;
  const author = message.author.displayName.trim() || message.author.handle;
  return `${author}: ${snippet}`;
}

export type MessageActionListItem = {
  key: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  hint?: string;
  icon?: ComponentProps<typeof Ionicons>['name'];
};

export interface MessageActionSheetProps {
  visible: boolean;
  actions: MessageActionListItem[];
  onClose: () => void;
  title?: string;
  reactions?: {
    onQuickReact: (emoji: string) => void;
    onPickerReact: (emoji: string) => void;
  };
  /** Shared bottom-sheet body for compact configuration surfaces. */
  content?: ReactNode;
}

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
  onDelegate?: (m: ChatMessage) => void;
}

function Action({
  label,
  hint,
  destructive,
  icon,
  focusRef,
  onPress,
}: {
  label: string;
  hint?: string;
  destructive?: boolean;
  icon?: ComponentProps<typeof Ionicons>['name'];
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
      {icon ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Ionicons name={icon} size={19} color={destructive ? colors.danger : colors.textSecondary} />
          <Text
            style={{
              color: destructive ? colors.danger : colors.text,
              fontSize: font.md,
              fontWeight: '500',
            }}
          >
            {label}
          </Text>
        </View>
      ) : (
        <Text
          style={{
            color: destructive ? colors.danger : colors.text,
            fontSize: font.md,
            fontWeight: '500',
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function MessageActionSheet({ visible, actions, onClose, title, reactions, content }: MessageActionSheetProps) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const [pickerVisible, setPickerVisible] = useState(false);
  const firstActionRef = useRef<View>(null);
  const canReact = reactions != null;

  useModalAccessibilityFocus(firstActionRef, visible);

  useEffect(() => {
    setPickerVisible(false);
  }, [visible]);

  const closeAll = () => {
    setPickerVisible(false);
    onClose();
  };

  const firstActionIndex = canReact ? -1 : 0;

  return (
    <Modal visible={visible} transparent animationType={reduceMotion ? 'none' : 'fade'} onRequestClose={closeAll}>
      <Pressable
        // Scrim: tap-to-dismiss for sighted users. It must NOT be an accessibility
        // element — a labelled, role="button" container collapses into a single a11y
        // node on iOS and HIDES all its children (the reactions + actions) from
        // VoiceOver and from UI test drivers. VoiceOver users close via "Cancel" below.
        accessible={false}
        importantForAccessibility="no"
        style={{ flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' }}
        onPress={closeAll}
      >
        <Pressable
          // Inner sheet only exists to swallow taps (so they don't hit the scrim).
          // Same a11y rule as the scrim: it must not be an accessibility element, or
          // it collapses every action into one combined node instead of exposing the
          // individual reaction/action buttons.
          accessible={false}
          importantForAccessibility="no"
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
          {pickerVisible && reactions ? (
            <ReactionPickerBody
              onBack={() => setPickerVisible(false)}
              onSelect={(emoji) => {
                selectionHaptic();
                reactions.onPickerReact(emoji);
                closeAll();
              }}
            />
          ) : (
            <>
              {content ? <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>{content}</View> : null}
              {title ? (
                <Text
                  accessibilityRole="header"
                  numberOfLines={2}
                  style={{
                    color: colors.textMuted,
                    fontSize: font.sm,
                    fontWeight: '700',
                    paddingHorizontal: space.lg,
                    paddingBottom: space.md,
                  }}
                >
                  {title}
                </Text>
              ) : null}
              {reactions ? (
                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    gap: space.sm,
                    paddingHorizontal: space.lg,
                    paddingBottom: space.md,
                  }}
                >
                  {QUICK_REACTIONS.map((e, index) => (
                    <Pressable
                      ref={index === 0 ? firstActionRef : undefined}
                      key={e}
                      accessibilityRole="button"
                      accessibilityLabel={`React with ${e}`}
                      accessibilityHint="Adds this reaction to the message"
                      onPress={() => {
                        selectionHaptic();
                        reactions.onQuickReact(e);
                        closeAll();
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
                  <Pressable
                    key="more-reactions"
                    accessibilityRole="button"
                    accessibilityLabel="Open reaction picker"
                    accessibilityHint="Shows all available reactions"
                    onPress={() => {
                      selectionHaptic();
                      setPickerVisible(true);
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
                    <Text style={{ color: colors.textSecondary, fontSize: 22, fontWeight: '600' }}>＋</Text>
                  </Pressable>
                </View>
              ) : null}
              <View style={{ height: 1, backgroundColor: colors.border }} />
              {actions.map((action, index) => (
                <Action
                  key={action.key}
                  label={action.label}
                  hint={action.hint}
                  destructive={action.destructive}
                  icon={action.icon}
                  focusRef={index === firstActionIndex ? firstActionRef : undefined}
                  onPress={action.onSelect}
                />
              ))}
              <Action
                label="Cancel"
                hint="Closes the action menu"
                focusRef={actions.length === 0 && !canReact ? firstActionRef : undefined}
                onPress={closeAll}
              />
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
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
  onDelegate,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
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

  useAccessibilityAnnouncement(copied ? 'Message text copied.' : copiedLink ? 'Message link copied.' : null);

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

  const actions: MessageActionListItem[] = [];
  if (m && canReplyAction) {
    actions.push({
      key: 'reply',
      label: 'Reply in thread',
      hint: 'Opens the thread for this message',
      onSelect: () => {
        onReply(m);
        onClose();
      },
    });
  }
  if (m && confirmed && !sessionBlock && onDelegate) {
    actions.push({
      key: 'delegate',
      label: 'Delegate to agent…',
      hint: 'Opens the agent composer anchored to this message',
      onSelect: () => {
        onDelegate(m);
        onClose();
      },
    });
  }
  if (m && canMarkupReplyAction) {
    actions.push({
      key: 'markup-reply',
      label: 'Mark up & reply',
      hint: 'Starts a markup reply from this message',
      onSelect: () => {
        onMarkupReply(m);
        onClose();
      },
    });
  }
  if (m && copyText) {
    actions.push({
      key: 'copy-text',
      label: copied ? 'Copied' : 'Copy text',
      hint: 'Copies the message text to the clipboard',
      onSelect: () => {
        selectionHaptic();
        void Clipboard.setStringAsync(copyText)
          .then(() => {
            setCopied(true);
            closeAfterCopy();
          })
          .catch(() => onClose());
      },
    });
  }
  if (m && copyLink) {
    actions.push({
      key: 'copy-link',
      label: copiedLink ? 'Copied link' : 'Copy link',
      hint: 'Copies a link to this message to the clipboard',
      onSelect: () => {
        selectionHaptic();
        void Clipboard.setStringAsync(copyLink)
          .then(() => {
            setCopiedLink(true);
            closeAfterCopy();
          })
          .catch(() => onClose());
      },
    });
  }
  if (m && canMutateMessage) {
    actions.push({
      key: 'edit',
      label: 'Edit message',
      hint: 'Opens this message for editing',
      onSelect: () => {
        onEdit(m);
        onClose();
      },
    });
    actions.push({
      key: 'delete',
      label: 'Delete message',
      hint: 'Opens a confirmation before deleting this message',
      destructive: true,
      onSelect: () => {
        onClose();
        Alert.alert('Delete message?', 'This cannot be undone.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => onDelete(m) },
        ]);
      },
    });
  }

  return (
    <MessageActionSheet
      visible={m != null}
      actions={actions}
      onClose={onClose}
      reactions={
        m && canReact
          ? {
              onQuickReact: (emoji) => onReact(m, emoji),
              onPickerReact: (emoji) => onReact(m, emoji),
            }
          : undefined
      }
    />
  );
}
