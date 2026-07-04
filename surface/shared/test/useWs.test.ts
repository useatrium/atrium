import { describe, expect, it, vi } from 'vitest';
import {
  createWsSequenceTracker,
  decodeWsFrame,
  handleWsFrameSequence,
  resetWsSequenceTracker,
} from '../src/useWs';
import type { WireEvent } from '../src/timeline';

const user = { id: 'u1', handle: 'alice', displayName: 'Alice' };

const wireEvent: WireEvent = {
  id: 1,
  workspaceId: 'w1',
  channelId: 'c1',
  threadRootEventId: null,
  type: 'message.posted',
  actorId: 'u1',
  payload: { text: 'hello' },
  createdAt: '2026-07-04T12:00:00.000Z',
  author: user,
};

const call = {
  id: 'call-1',
  channelId: 'c1',
  initiatorId: 'u1',
  status: 'ringing',
  startedAt: '2026-07-04T12:00:00.000Z',
  participants: [user],
};

describe('websocket sequence tracking', () => {
  it('fires the gap callback when a frame skips ahead', () => {
    const tracker = createWsSequenceTracker();
    const onGap = vi.fn();

    handleWsFrameSequence(tracker, { seq: 1 }, onGap);
    handleWsFrameSequence(tracker, { seq: 3 }, onGap);
    handleWsFrameSequence(tracker, { seq: 4 }, onGap);

    expect(onGap).toHaveBeenCalledTimes(1);
  });

  it('does not fire on contiguous frames', () => {
    const tracker = createWsSequenceTracker();
    const onGap = vi.fn();

    handleWsFrameSequence(tracker, { seq: 1 }, onGap);
    handleWsFrameSequence(tracker, { seq: 2 }, onGap);
    handleWsFrameSequence(tracker, { seq: 3 }, onGap);

    expect(onGap).not.toHaveBeenCalled();
  });

  it('resets expected sequence on reconnect', () => {
    const tracker = createWsSequenceTracker();
    const onGap = vi.fn();

    handleWsFrameSequence(tracker, { seq: 1 }, onGap);
    handleWsFrameSequence(tracker, { seq: 2 }, onGap);
    resetWsSequenceTracker(tracker);
    handleWsFrameSequence(tracker, { seq: 1 }, onGap);

    expect(onGap).not.toHaveBeenCalled();
  });

  it('disables gap detection for unstamped server frames', () => {
    const tracker = createWsSequenceTracker();
    const onGap = vi.fn();

    handleWsFrameSequence(tracker, {}, onGap);
    handleWsFrameSequence(tracker, { seq: 10 }, onGap);

    expect(onGap).not.toHaveBeenCalled();
  });
});

describe('websocket frame decoding', () => {
  it.each([
    ['event', { type: 'event', event: wireEvent }],
    ['presence', { type: 'presence', channelId: 'c1', users: [user] }],
    ['channel typing', { type: 'typing', channelId: 'c1', user }],
    ['session typing', { type: 'typing', sessionId: 's1', user }],
    ['read', { type: 'read', channelId: 'c1', lastReadEventId: 4 }],
    ['muted', { type: 'muted', channelId: 'c1', muted: true }],
    ['channel-left', { type: 'channel-left', channelId: 'c1' }],
    ['prefs', { type: 'prefs', prefs: { theme: 'dark' } }],
    ['pong', { type: 'pong', t: 123 }],
    ['call.ringing', { type: 'call.ringing', call }],
    ['call.accepted', { type: 'call.accepted', callId: 'call-1', user }],
    ['call.declined', { type: 'call.declined', callId: 'call-1', userId: 'u1' }],
    ['call.participant_joined', { type: 'call.participant_joined', callId: 'call-1', user }],
    ['call.participant_left', { type: 'call.participant_left', callId: 'call-1', userId: 'u1' }],
    ['call.ended', { type: 'call.ended', callId: 'call-1' }],
  ])('decodes %s frames', (_name, frame) => {
    expect(decodeWsFrame(frame)).toMatchObject(frame);
  });

  it('keeps non-number seq values so legacy sequence handling can disable itself', () => {
    const decoded = decodeWsFrame({ type: 'event', event: wireEvent, seq: 'bad-seq' });

    expect(decoded).toMatchObject({ type: 'event', seq: 'bad-seq' });
  });

  it('advances sequence tracking across protocol pong frames', () => {
    const tracker = createWsSequenceTracker();
    const onGap = vi.fn();

    for (const raw of [
      { type: 'event', event: wireEvent, seq: 1 },
      { type: 'pong', t: 123, seq: 2 },
      { type: 'event', event: { ...wireEvent, id: 2 }, seq: 3 },
    ]) {
      const decoded = decodeWsFrame(raw);
      expect(decoded).not.toBeNull();
      handleWsFrameSequence(tracker, decoded!, onGap);
    }

    expect(onGap).not.toHaveBeenCalled();
  });

  it('rejects event frames with malformed stable event fields', () => {
    expect(decodeWsFrame({
      type: 'event',
      event: { ...wireEvent, id: 'not-a-number' },
    })).toBeNull();
  });

  it('rejects frames with malformed stable user fields', () => {
    expect(decodeWsFrame({
      type: 'typing',
      channelId: 'c1',
      user: { id: 'u1', handle: 'alice' },
    })).toBeNull();
  });

  it('keeps prefs payloads loose for normalizePrefs', () => {
    expect(decodeWsFrame({ type: 'prefs', prefs: null })).toEqual({
      type: 'prefs',
      prefs: null,
    });
  });
});
