import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  emptyTimeline,
  mergeHistory,
  messageFromEvent,
  type WireEvent,
} from '../src/index';

const alice = { id: 'u-alice', handle: 'alice', displayName: 'Alice' };

function voicePost(id: number, opts: { withTranscript?: boolean } = {}): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    type: 'message.posted',
    actorId: alice.id,
    payload: {
      text: '',
      attachments: [{ id: 'file-1', filename: 'voice.webm', contentType: 'audio/webm', size: 1234 }],
      voice: {
        fileId: 'file-1',
        durationMs: 4200,
        waveform: [0.1, 0.8, 0.3],
        ...(opts.withTranscript ? { transcript: { status: 'done', text: 'hi there', lang: 'en' } } : {}),
      },
    },
    createdAt: '2026-06-13T00:00:00.000Z',
    author: alice,
  };
}

function transcribed(id: number, targetEventId: number): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    type: 'voice.transcribed',
    actorId: null,
    payload: { target_event_id: targetEventId, transcript: { status: 'done', text: 'hello world', lang: 'en' } },
    createdAt: '2026-06-13T00:00:01.000Z',
    author: null,
  };
}

describe('voice messages', () => {
  it('parses a voice payload into ChatMessage.voice with a pending transcript by default', () => {
    const msg = messageFromEvent(voicePost(1));
    expect(msg.voice).toBeDefined();
    expect(msg.voice).toMatchObject({ fileId: 'file-1', durationMs: 4200, waveform: [0.1, 0.8, 0.3] });
    expect(msg.voice!.transcript).toEqual({ status: 'pending' });
    // The audio is still a normal attachment.
    expect(msg.attachments?.[0]?.id).toBe('file-1');
  });

  it('keeps a transcript already materialized on the payload', () => {
    const msg = messageFromEvent(voicePost(1, { withTranscript: true }));
    expect(msg.voice!.transcript).toEqual({ status: 'done', text: 'hi there', lang: 'en' });
  });

  it('applies a voice.transcribed modifier to the target message', () => {
    let t = applyEvent(emptyTimeline, voicePost(1));
    expect(t.main[0]!.voice!.transcript.status).toBe('pending');
    t = applyEvent(t, transcribed(2, 1));
    expect(t.main[0]!.voice!.transcript).toEqual({ status: 'done', text: 'hello world', lang: 'en' });
    expect(t.lastEventId).toBe(2);
  });

  it('is idempotent and order-independent for the transcript modifier', () => {
    const post = voicePost(1);
    const tr = transcribed(2, 1);
    const inOrder = applyEvent(applyEvent(emptyTimeline, post), tr);
    // Duplicate delivery of the modifier must not change the result.
    const dup = applyEvent(inOrder, tr);
    expect(dup.main[0]!.voice!.transcript).toEqual(inOrder.main[0]!.voice!.transcript);
    // A modifier that arrives before its target row is safely dropped (no crash).
    const early = applyEvent(emptyTimeline, tr);
    expect(early.main).toHaveLength(0);
  });

  it('re-applies the transcript when hydrating history (modifier replay)', () => {
    const t = mergeHistory(emptyTimeline, [voicePost(1), transcribed(2, 1)], { hasMoreBefore: false });
    expect(t.main).toHaveLength(1);
    expect(t.main[0]!.voice!.transcript.status).toBe('done');
  });
});
