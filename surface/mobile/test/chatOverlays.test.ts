// Guards the two chat-overlay seams mobile now shares with web:
//   GAP 1 — the live send() builds its optimistic row from the shared
//            pendingMessageFromSendPayload (incl. voice + waveform), replacing
//            the old inline copy.
//   GAP 2 — a thread steer becomes an optimistic thread row (steeredSessionId)
//            on both the live-enqueue (pendingMessageFromThreadSteerPayload) and
//            offline queue-recovery (applyQueuedOp → queuedOverlayAction) paths,
//            and reconciles through the real appReducer when the op lands.
//
// These exercise the exact shared constructors the mobile ChatProvider wires to
// (mobile/src/lib/chat.tsx) with mobile-shaped payloads, plus the real reducer
// for the land/reconcile step — no fragile full-provider render required.
import { describe, expect, it } from 'vitest';
import {
  appReducer,
  initialAppState,
  pendingMessageFromSendPayload,
  pendingMessageFromThreadSteerPayload,
  queuedOverlayAction,
  type AppState,
  type MsgSendPayload,
  type QueuedThreadSteerPayload,
  type UserRef,
  type WireEvent,
} from '@atrium/surface-client';

const me: UserRef = { id: 'u1', handle: 'me', displayName: 'Me User' };

// Mirrors the payload mobile's send() feeds pendingMessageFromSendPayload.
function mobileSendPayload(over: Partial<MsgSendPayload> & { voice?: MsgSendPayload['voice'] }): MsgSendPayload {
  return {
    clientMsgId: 'cm-send',
    channelId: 'c1',
    text: 'listen',
    createdAt: '2026-07-12T00:00:05.000Z',
    ...over,
  };
}

// Mirrors the payload mobile's steerSession() builds when a steer posts into a
// thread (postToThread + full provenance).
function mobileThreadSteerPayload(over: Partial<QueuedThreadSteerPayload> = {}): QueuedThreadSteerPayload {
  return {
    sessionId: 's1',
    text: 'do the thing',
    postToThread: true,
    channelId: 'c1',
    threadRootEventId: 41,
    clientMsgId: 'cm-steer',
    createdAt: '2026-07-12T00:00:06.000Z',
    ...over,
  };
}

function rootEvent(id: number): WireEvent {
  return {
    id,
    workspaceId: 'w1',
    channelId: 'c1',
    threadRootEventId: null,
    type: 'message.posted',
    actorId: 'them',
    payload: { text: 'thread root' },
    createdAt: '2026-07-12T00:00:00.000Z',
    author: { id: 'them', handle: 'them', displayName: 'Them' },
  } as unknown as WireEvent;
}

function postedThreadReply(id: number, clientMsgId: string): WireEvent {
  return {
    id,
    workspaceId: 'w1',
    channelId: 'c1',
    threadRootEventId: 41,
    type: 'message.posted',
    actorId: me.id,
    payload: { text: 'do the thing', client_msg_id: clientMsgId },
    createdAt: '2026-07-12T00:01:00.000Z',
    author: me,
  } as unknown as WireEvent;
}

// A c1 timeline that is loaded and holds thread root 41, matching an open thread.
function loadedThreadState(): AppState {
  let state = appReducer(initialAppState, { type: 'init-me', handle: me.handle, id: me.id });
  state = appReducer(state, {
    type: 'history-loaded',
    channelId: 'c1',
    events: [rootEvent(41)],
    hasMore: false,
  } as never);
  return state;
}

describe('mobile chat overlays', () => {
  describe('GAP 1: live send optimistic row', () => {
    it('builds a voice row with waveform and the attachment file id', () => {
      const payload = mobileSendPayload({
        attachments: [{ id: 'file-1', filename: 'voice.webm', contentType: 'audio/webm', size: 128 }],
        voice: { durationMs: 1200, waveform: [0, 1, 0.4] },
      });

      const message = pendingMessageFromSendPayload(payload, me);

      expect(message.status).toBe('pending');
      expect(message.author).toEqual(me);
      expect(message.voice).toEqual({
        fileId: 'file-1',
        durationMs: 1200,
        waveform: [0, 1, 0.4],
        transcript: { status: 'pending' },
      });
    });

    it('omits the voice slot for a plain text send', () => {
      const message = pendingMessageFromSendPayload(mobileSendPayload({ text: 'just text' }), me);
      expect(message.text).toBe('just text');
      expect(message.voice).toBeUndefined();
      expect(message.attachments).toBeUndefined();
    });
  });

  describe('GAP 2: thread steer optimistic row', () => {
    it('turns a queued session.steer op into an optimistic thread row (recovery path)', () => {
      const overlay = queuedOverlayAction(
        { opId: 'cm-steer', opType: 'session.steer', payload: mobileThreadSteerPayload() },
        me,
      );

      expect(overlay).not.toBeNull();
      const action = overlay!.action;
      expect(action.type).toBe('send-pending');
      if (action.type !== 'send-pending') throw new Error('expected send-pending');
      expect(action.channelId).toBe('c1');
      expect(action.message.steeredSessionId).toBe('s1');
      expect(action.message.threadRootEventId).toBe(41);
      expect(action.message.text).toBe('do the thing');
      expect(action.message.status).toBe('pending');
    });

    it('drops the overlay when a steer lacks thread provenance (dead-overlay guard)', () => {
      // A steer enqueued without channelId/threadRootEventId/clientMsgId — the
      // shape mobile used to send before the enqueue-site fix — must not render.
      expect(
        queuedOverlayAction(
          { opId: 'x', opType: 'session.steer', payload: { sessionId: 's1', text: 'hi', postToThread: true } },
          me,
        ),
      ).toBeNull();
    });

    it('renders the live optimistic thread row and reconciles when the steer lands', () => {
      const payload = mobileThreadSteerPayload();
      // Live path: steerSession dispatches send-pending in onStored.
      let state = loadedThreadState();
      state = appReducer(state, {
        type: 'send-pending',
        channelId: 'c1',
        message: pendingMessageFromThreadSteerPayload(payload, me),
      });

      const pending = state.timelines.c1?.threads[41] ?? [];
      expect(pending).toHaveLength(1);
      const [row] = pending;
      if (!row) throw new Error('expected an optimistic thread row');
      expect(row.status).toBe('pending');
      expect(row.steeredSessionId).toBe('s1');
      expect(row.clientMsgId).toBe('cm-steer');

      // The steer lands: the server broadcasts the thread message over the WS.
      state = appReducer(state, { type: 'server-event', event: postedThreadReply(500, 'cm-steer') });

      const settled = state.timelines.c1?.threads[41] ?? [];
      expect(settled.some((m) => m.id === 500 && m.status === 'confirmed')).toBe(true);
      expect(settled.some((m) => m.status === 'pending' && m.clientMsgId === 'cm-steer')).toBe(false);
    });
  });

  describe('GAP 2: applyQueuedOp delegates every overlay op to the shared mapper', () => {
    // Mobile's applyQueuedOp switched from a hand-rolled if-chain to
    // queuedOverlayAction wholesale; the edit/delete/reaction/mute/read overlays
    // it used to build inline must still map to the same reducer actions.
    it('maps edit/delete/reaction/mute/read ops', () => {
      expect(
        queuedOverlayAction({ opId: 'e', opType: 'msg.edit', payload: { channelId: 'c1', eventId: 7, text: 'x' } }, me)
          ?.action,
      ).toEqual({ type: 'edit-overlay-pending', channelId: 'c1', opId: 'e', targetEventId: 7, text: 'x' });

      expect(
        queuedOverlayAction({ opId: 'd', opType: 'msg.delete', payload: { channelId: 'c1', eventId: 8 } }, me)?.action,
      ).toEqual({ type: 'delete-overlay-pending', channelId: 'c1', opId: 'd', targetEventId: 8 });

      expect(
        queuedOverlayAction(
          {
            opId: 'r',
            opType: 'reaction.set',
            payload: { channelId: 'c1', eventId: 9, emoji: ':+1:', action: 'add', userId: 'u1' },
          },
          me,
        )?.action,
      ).toEqual({
        type: 'reaction-overlay-pending',
        channelId: 'c1',
        opId: 'r',
        targetEventId: 9,
        emoji: ':+1:',
        userId: 'u1',
        action: 'add',
      });

      expect(
        queuedOverlayAction({ opId: 'm', opType: 'mute.set', payload: { channelId: 'c1', muted: true } }, me)?.action,
      ).toEqual({ type: 'mute-changed', channelId: 'c1', muted: true });

      // read.mark carries the readCursor side-channel mobile maps onto
      // lastReadSentRef + cacheReadCursorAdvance.
      expect(
        queuedOverlayAction({ opId: 'rd', opType: 'read.mark', payload: { channelId: 'c1', lastReadEventId: 12 } }, me),
      ).toEqual({
        action: { type: 'read-cursor', channelId: 'c1', lastReadEventId: 12 },
        readCursor: { channelId: 'c1', lastReadEventId: 12 },
      });
    });
  });
});
