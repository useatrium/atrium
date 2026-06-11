import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import {
  formatTime,
  formatBytes,
  type ChatMessage,
  type MessageReaction,
  type Session,
} from '@atrium/surface-client';
import { colors, font, radius, space } from '../lib/theme';
import { Avatar } from './Avatar';
import { MessageText } from './MessageText';

const IMAGE_MAX_W = 240;

export interface MessageRowProps {
  message: ChatMessage;
  grouped: boolean;
  meId: string;
  meHandle: string | null;
  highlighted?: boolean;
  /** Agent-session entity for session.spawned rows. */
  session?: Session;
  /** Hide the reply-count pill (inside a thread screen). */
  inThread?: boolean;
  fileUrl: (id: string) => string;
  onLongPress: (m: ChatMessage) => void;
  onOpenThread?: (m: ChatMessage) => void;
  onToggleReaction: (m: ChatMessage, emoji: string) => void;
  onRetry: (m: ChatMessage) => void;
  onOpenAttachment: (fileId: string) => void;
}

function ReactionChips({
  reactions,
  meId,
  onToggle,
}: {
  reactions: MessageReaction[];
  meId: string;
  onToggle: (emoji: string) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
      {reactions.map((r) => {
        const mine = r.userIds.includes(meId);
        return (
          <Pressable
            key={r.emoji}
            onPress={() => onToggle(r.emoji)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 8,
              paddingVertical: 3,
              borderRadius: 999,
              backgroundColor: mine ? colors.accentBg : colors.bgElevated,
              borderWidth: 1,
              borderColor: mine ? colors.accent : colors.border,
            }}
          >
            <Text style={{ fontSize: 13 }}>{r.emoji}</Text>
            <Text
              style={{
                fontSize: font.xs,
                fontWeight: '600',
                color: mine ? colors.accent : colors.textSecondary,
              }}
            >
              {r.userIds.length}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Attachments({
  message,
  fileUrl,
  onOpen,
}: {
  message: ChatMessage;
  fileUrl: (id: string) => string;
  onOpen: (fileId: string) => void;
}) {
  if (!message.attachments?.length) return null;
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      {message.attachments.map((a) => {
        if (a.contentType.startsWith('image/')) {
          const ratio = a.width && a.height ? a.width / a.height : 4 / 3;
          const w = Math.min(IMAGE_MAX_W, a.width ?? IMAGE_MAX_W);
          return (
            <Pressable key={a.id} onPress={() => onOpen(a.id)}>
              <Image
                source={{ uri: fileUrl(a.id) }}
                style={{
                  width: w,
                  height: Math.round(w / ratio),
                  borderRadius: radius.md,
                  backgroundColor: colors.bgElevated,
                }}
                contentFit="cover"
                transition={120}
              />
            </Pressable>
          );
        }
        return (
          <Pressable
            key={a.id}
            onPress={() => onOpen(a.id)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              padding: space.sm,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.bgElevated,
              alignSelf: 'flex-start',
              maxWidth: 280,
            }}
          >
            <Text style={{ fontSize: 16 }}>📎</Text>
            <View style={{ flexShrink: 1 }}>
              <Text style={{ color: colors.text, fontSize: font.sm }} numberOfLines={1}>
                {a.filename}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
                {formatBytes(a.size)}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Agent-session rows render as a compact status card (panes are web-only). */
function SessionCard({ message, session }: { message: ChatMessage; session?: Session }) {
  const status = session?.status ?? 'spawning';
  const statusColor =
    status === 'completed'
      ? colors.online
      : status === 'failed' || status === 'cancelled'
        ? colors.danger
        : colors.warning;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        padding: space.md,
        gap: 4,
        marginTop: 2,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ fontSize: font.xs, color: colors.textMuted, fontWeight: '700' }}>
          ⚙ AGENT SESSION
        </Text>
        <Text style={{ fontSize: font.xs, color: statusColor, fontWeight: '700' }}>
          {status.toUpperCase()}
        </Text>
      </View>
      <Text style={{ color: colors.text, fontSize: font.sm }} numberOfLines={3}>
        {session?.title ?? message.text}
      </Text>
      {session?.resultText ? (
        <Text style={{ color: colors.textSecondary, fontSize: font.xs }} numberOfLines={2}>
          {session.resultText}
        </Text>
      ) : null}
      <Text style={{ color: colors.textFaint, fontSize: font.xs }}>
        Open Atrium on desktop to view this session
      </Text>
    </View>
  );
}

export const MessageRow = memo(function MessageRow({
  message: m,
  grouped,
  meId,
  meHandle,
  highlighted,
  session,
  inThread,
  fileUrl,
  onLongPress,
  onOpenThread,
  onToggleReaction,
  onRetry,
  onOpenAttachment,
}: MessageRowProps) {
  const pending = m.status === 'pending';
  const failed = m.status === 'failed';
  const tombstone = m.deleted === true;

  const body = tombstone ? (
    <Text style={{ color: colors.textFaint, fontSize: font.md, fontStyle: 'italic' }}>
      Message deleted
    </Text>
  ) : m.sessionId != null ? (
    <SessionCard message={m} session={session} />
  ) : (
    <>
      {m.text ? <MessageText text={m.text} meHandle={meHandle} muted={pending} /> : null}
      <Attachments message={m} fileUrl={fileUrl} onOpen={onOpenAttachment} />
    </>
  );

  return (
    <Pressable
      onLongPress={() => {
        if (tombstone || m.sessionId != null) return;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onLongPress(m);
      }}
      delayLongPress={250}
      style={({ pressed }) => ({
        flexDirection: 'row',
        paddingHorizontal: space.lg,
        paddingTop: grouped ? 1 : space.sm,
        paddingBottom: 1,
        gap: space.md,
        opacity: pending ? 0.55 : 1,
        backgroundColor: highlighted
          ? colors.accentBg
          : pressed
            ? colors.borderSoft
            : 'transparent',
      })}
    >
      <View style={{ width: 36, alignItems: 'center' }}>
        {!grouped && <Avatar name={m.author.displayName} seed={m.author.id} size={36} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {!grouped && (
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }}>
              {m.author.displayName}
            </Text>
            <Text style={{ color: colors.textFaint, fontSize: font.xs }}>
              {formatTime(m.createdAt)}
            </Text>
          </View>
        )}
        {body}
        {m.edited && !tombstone ? (
          <Text style={{ color: colors.textFaint, fontSize: font.xs }}>(edited)</Text>
        ) : null}
        {failed && (
          <Pressable onPress={() => onRetry(m)}>
            <Text style={{ color: colors.danger, fontSize: font.xs, marginTop: 2 }}>
              Failed to send — tap to retry
            </Text>
          </Pressable>
        )}
        {m.reactions && m.reactions.length > 0 && (
          <ReactionChips
            reactions={m.reactions}
            meId={meId}
            onToggle={(emoji) => onToggleReaction(m, emoji)}
          />
        )}
        {!inThread && m.replyCount > 0 && onOpenThread && (
          <Pressable
            onPress={() => onOpenThread(m)}
            style={{ marginTop: 4, alignSelf: 'flex-start' }}
          >
            <Text style={{ color: colors.accent, fontSize: font.sm, fontWeight: '600' }}>
              {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'} →
            </Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
});
