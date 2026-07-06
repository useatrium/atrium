import type {
  AppAction,
  ChatMessage,
  MsgSendPayload,
  OpType,
  ReactionSetPayload,
  SessionSpawnPayload,
  UserRef,
  VoiceMeta,
} from '@atrium/surface-client';
import type { Session } from './sessions/types';

export type VoiceMsgSendPayload = MsgSendPayload & {
  voice?: Pick<VoiceMeta, 'fileId' | 'durationMs' | 'waveform'>;
};

export type QueuedOverlayOp = { opType: OpType; payload: unknown; opId: string };

export function pendingMessageFromSendPayload(msg: MsgSendPayload, me: UserRef): ChatMessage {
  const voice = (msg as VoiceMsgSendPayload).voice;
  const voiceFileId = voice?.fileId ?? msg.attachments?.[0]?.id;
  return {
    id: null,
    clientMsgId: msg.clientMsgId,
    channelId: msg.channelId,
    threadRootEventId: msg.threadRootEventId ?? null,
    text: msg.text,
    edited: false,
    ...(msg.broadcast === true ? { broadcast: true } : {}),
    author: me,
    createdAt: msg.createdAt ?? new Date().toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'pending',
    ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
    ...(voice && voiceFileId
      ? {
          voice: {
            fileId: voiceFileId,
            durationMs: voice.durationMs,
            ...(voice.waveform ? { waveform: voice.waveform } : {}),
            transcript: { status: 'pending' },
          },
        }
      : {}),
  };
}

export function pendingSpawnFromPayload(
  payload: SessionSpawnPayload,
  me: UserRef,
): { message: ChatMessage; session: Session } {
  const createdAt = payload.createdAt ?? new Date().toISOString();
  return {
    session: {
      id: payload.clientSpawnId,
      workspaceId: '',
      channelId: payload.channelId,
      threadRootEventId: payload.threadRootEventId ?? null,
      title: payload.task.slice(0, 80),
      status: 'spawning',
      harness: payload.harness ?? 'codex',
      repo: payload.repo ?? null,
      branch: payload.branch ?? null,
      spawnedBy: me.id,
      spawnerName: me.displayName,
      driverId: null,
      pendingSeatRequests: [],
      suggestions: [],
      answerProposals: [],
      providerAuthRequired: null,
      seatEvents: [],
      costUsd: 0,
      resultText: null,
      createdAt,
      completedAt: null,
      lastEventId: 0,
      permalink: '',
    },
    message: {
      id: null,
      clientMsgId: payload.clientSpawnId,
      channelId: payload.channelId,
      threadRootEventId: payload.threadRootEventId ?? null,
      text: payload.task,
      edited: false,
      author: me,
      createdAt,
      replyCount: 0,
      lastReplyId: 0,
      status: 'pending',
      sessionId: payload.clientSpawnId,
      ...(payload.attachments && payload.attachments.length > 0 ? { attachments: payload.attachments } : {}),
    },
  };
}

export function queuedOverlayAction(
  op: QueuedOverlayOp,
  me: UserRef,
): { action: AppAction; readCursor?: { channelId: string; lastReadEventId: number } } | null {
  if (op.opType === 'msg.send') {
    const payload = op.payload as MsgSendPayload;
    return {
      action: {
        type: 'send-pending',
        channelId: payload.channelId,
        message: pendingMessageFromSendPayload(payload, me),
      },
    };
  }
  if (op.opType === 'session.spawn') {
    const payload = op.payload as SessionSpawnPayload;
    const pending = pendingSpawnFromPayload(payload, me);
    return {
      action: {
        type: 'session-spawn-pending',
        channelId: payload.channelId,
        message: pending.message,
        session: pending.session,
      },
    };
  }
  if (op.opType === 'msg.edit') {
    const payload = op.payload as { channelId: string; eventId: number; text: string };
    return {
      action: {
        type: 'edit-overlay-pending',
        channelId: payload.channelId,
        opId: op.opId,
        targetEventId: payload.eventId,
        text: payload.text,
      },
    };
  }
  if (op.opType === 'msg.delete') {
    const payload = op.payload as { channelId: string; eventId: number };
    return {
      action: {
        type: 'delete-overlay-pending',
        channelId: payload.channelId,
        opId: op.opId,
        targetEventId: payload.eventId,
      },
    };
  }
  if (op.opType === 'reaction.set') {
    const payload = op.payload as ReactionSetPayload;
    return {
      action: {
        type: 'reaction-overlay-pending',
        channelId: payload.channelId,
        opId: op.opId,
        targetEventId: payload.eventId,
        emoji: payload.emoji,
        userId: payload.userId,
        action: payload.action,
      },
    };
  }
  if (op.opType === 'mute.set') {
    const payload = op.payload as { channelId: string; muted: boolean };
    return {
      action: { type: 'mute-changed', channelId: payload.channelId, muted: payload.muted },
    };
  }
  if (op.opType === 'read.mark') {
    const payload = op.payload as { channelId: string; lastReadEventId: number };
    return {
      action: {
        type: 'read-cursor',
        channelId: payload.channelId,
        lastReadEventId: payload.lastReadEventId,
      },
      readCursor: {
        channelId: payload.channelId,
        lastReadEventId: payload.lastReadEventId,
      },
    };
  }
  return null;
}
