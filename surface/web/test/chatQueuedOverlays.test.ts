import { describe, expect, it } from 'vitest';
import type { MsgSendPayload, OpType, ReactionSetPayload, SessionSpawnPayload, UserRef } from '@atrium/surface-client';
import { pendingMessageFromSendPayload, pendingSpawnFromPayload, queuedOverlayAction } from '../src/chatQueuedOverlays';

const me: UserRef = { id: 'user-1', handle: 'me', displayName: 'Me User' };

describe('chatQueuedOverlays', () => {
  it('builds pending message rows with attachments and voice metadata', () => {
    const payload: MsgSendPayload & { voice: { durationMs: number; waveform: number[] } } = {
      channelId: 'ch-1',
      text: 'voice note',
      clientMsgId: 'client-msg-1',
      threadRootEventId: 42,
      createdAt: '2026-06-28T13:30:00.000Z',
      attachments: [
        {
          id: 'file-1',
          filename: 'voice.webm',
          contentType: 'audio/webm',
          size: 128,
        },
      ],
      voice: { durationMs: 1200, waveform: [0, 1, 0.4] },
    };

    expect(pendingMessageFromSendPayload(payload, me)).toEqual({
      id: null,
      clientMsgId: 'client-msg-1',
      channelId: 'ch-1',
      threadRootEventId: 42,
      text: 'voice note',
      edited: false,
      author: me,
      createdAt: '2026-06-28T13:30:00.000Z',
      replyCount: 0,
      lastReplyId: 0,
      status: 'pending',
      attachments: payload.attachments,
      voice: {
        fileId: 'file-1',
        durationMs: 1200,
        waveform: [0, 1, 0.4],
        transcript: { status: 'pending' },
      },
    });
  });

  it('builds pending voice rows from local voice file metadata before attachments resolve', () => {
    const payload: MsgSendPayload & {
      voice: { fileId: string; durationMs: number; waveform: number[] };
    } = {
      channelId: 'ch-1',
      text: '',
      clientMsgId: 'client-msg-voice',
      createdAt: '2026-06-28T13:45:00.000Z',
      attachmentRefs: [{ uploadKey: 'upload-1' }],
      voice: { fileId: 'file-from-voice', durationMs: 900, waveform: [0.2, 0.8] },
    };

    expect(pendingMessageFromSendPayload(payload, me)).toMatchObject({
      id: null,
      clientMsgId: 'client-msg-voice',
      channelId: 'ch-1',
      text: '',
      author: me,
      createdAt: '2026-06-28T13:45:00.000Z',
      status: 'pending',
      voice: {
        fileId: 'file-from-voice',
        durationMs: 900,
        waveform: [0.2, 0.8],
        transcript: { status: 'pending' },
      },
    });
  });

  it('builds pending session rows with defaults and spawner metadata', () => {
    const payload: SessionSpawnPayload = {
      channelId: 'ch-1',
      task: 'Run the quarterly report and summarize anomalies',
      clientSpawnId: 'pending-session-1',
      threadRootEventId: 77,
      repo: 'gbasin/atrium',
      branch: 'feature/reporting',
      createdAt: '2026-06-28T14:00:00.000Z',
    };

    const pending = pendingSpawnFromPayload(payload, me);

    expect(pending.session).toMatchObject({
      id: 'pending-session-1',
      workspaceId: '',
      channelId: 'ch-1',
      threadRootEventId: 77,
      title: 'Run the quarterly report and summarize anomalies',
      status: 'spawning',
      harness: 'codex',
      repo: 'gbasin/atrium',
      branch: 'feature/reporting',
      spawnedBy: 'user-1',
      spawnerName: 'Me User',
      costUsd: 0,
      permalink: '',
      createdAt: '2026-06-28T14:00:00.000Z',
    });
    expect(pending.message).toMatchObject({
      id: null,
      clientMsgId: 'pending-session-1',
      channelId: 'ch-1',
      threadRootEventId: 77,
      text: 'Run the quarterly report and summarize anomalies',
      author: me,
      status: 'pending',
      sessionId: 'pending-session-1',
      createdAt: '2026-06-28T14:00:00.000Z',
    });
  });

  it('maps queued overlay ops to reducer actions', () => {
    expect(
      queuedOverlayAction(
        {
          opId: 'edit-op',
          opType: 'msg.edit',
          payload: { channelId: 'ch-1', eventId: 11, text: 'updated' },
        },
        me,
      )?.action,
    ).toEqual({
      type: 'edit-overlay-pending',
      channelId: 'ch-1',
      opId: 'edit-op',
      targetEventId: 11,
      text: 'updated',
    });

    expect(
      queuedOverlayAction(
        {
          opId: 'delete-op',
          opType: 'msg.delete',
          payload: { channelId: 'ch-1', eventId: 12 },
        },
        me,
      )?.action,
    ).toEqual({
      type: 'delete-overlay-pending',
      channelId: 'ch-1',
      opId: 'delete-op',
      targetEventId: 12,
    });

    const reaction: ReactionSetPayload = {
      channelId: 'ch-1',
      eventId: 13,
      emoji: ':thumbsup:',
      action: 'add',
      userId: 'user-1',
    };
    expect(queuedOverlayAction({ opId: 'reaction-op', opType: 'reaction.set', payload: reaction }, me)?.action).toEqual(
      {
        type: 'reaction-overlay-pending',
        channelId: 'ch-1',
        opId: 'reaction-op',
        targetEventId: 13,
        emoji: ':thumbsup:',
        userId: 'user-1',
        action: 'add',
      },
    );

    expect(
      queuedOverlayAction({ opId: 'mute-op', opType: 'mute.set', payload: { channelId: 'ch-1', muted: true } }, me)
        ?.action,
    ).toEqual({ type: 'mute-changed', channelId: 'ch-1', muted: true });
  });

  it('returns read cursor metadata for read mark replay', () => {
    expect(
      queuedOverlayAction(
        {
          opId: 'read-op',
          opType: 'read.mark',
          payload: { channelId: 'ch-1', lastReadEventId: 99 },
        },
        me,
      ),
    ).toEqual({
      action: { type: 'read-cursor', channelId: 'ch-1', lastReadEventId: 99 },
      readCursor: { channelId: 'ch-1', lastReadEventId: 99 },
    });
  });

  it('ignores queued ops without optimistic overlays', () => {
    expect(
      queuedOverlayAction({ opId: 'upload-op', opType: 'upload' as OpType, payload: { uploadKey: 'upload-1' } }, me),
    ).toBeNull();
  });
});
