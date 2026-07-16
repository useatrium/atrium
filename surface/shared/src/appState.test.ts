import { describe, expect, it } from 'vitest';
import { appReducer, initialAppState } from './appState.js';

describe('conversation panel selection', () => {
  it('keeps the selected session when zooming out to its thread', () => {
    const withSession = appReducer(initialAppState, { type: 'open-session', sessionId: 'session-1' });
    const withThread = appReducer(withSession, { type: 'open-thread', rootEventId: 42 });

    expect(withThread.openSessionId).toBe('session-1');
    expect(withThread.openThreadRootId).toBe(42);
  });

  it('keeps the selected thread when zooming in to work', () => {
    const withThread = appReducer(initialAppState, { type: 'open-thread', rootEventId: 42 });
    const withSession = appReducer(withThread, { type: 'open-session', sessionId: 'session-1' });

    expect(withSession.openThreadRootId).toBe(42);
    expect(withSession.openSessionId).toBe('session-1');
  });

  it('still clears each selection explicitly', () => {
    const both = appReducer(appReducer(initialAppState, { type: 'open-thread', rootEventId: 42 }), {
      type: 'open-session',
      sessionId: 'session-1',
    });

    const withoutSession = appReducer(both, { type: 'close-session' });
    expect(withoutSession.openSessionId).toBeNull();
    expect(withoutSession.openThreadRootId).toBe(42);

    const withoutEither = appReducer(withoutSession, { type: 'close-thread' });
    expect(withoutEither.openThreadRootId).toBeNull();
  });

  it('routes both conversation axes in one transition', () => {
    const routed = appReducer(initialAppState, {
      type: 'route-conversation',
      threadRootId: 42,
      sessionId: 'session-1',
    });

    expect(routed.openThreadRootId).toBe(42);
    expect(routed.openSessionId).toBe('session-1');
  });

  it('preserves either axis when the full desired pair passes its current value', () => {
    const both = appReducer(initialAppState, {
      type: 'route-conversation',
      threadRootId: 42,
      sessionId: 'session-1',
    });
    const changedSession = appReducer(both, {
      type: 'route-conversation',
      threadRootId: both.openThreadRootId,
      sessionId: 'session-2',
    });
    const changedThread = appReducer(changedSession, {
      type: 'route-conversation',
      threadRootId: 84,
      sessionId: changedSession.openSessionId,
    });

    expect(changedSession.openThreadRootId).toBe(42);
    expect(changedSession.openSessionId).toBe('session-2');
    expect(changedThread.openThreadRootId).toBe(84);
    expect(changedThread.openSessionId).toBe('session-2');
  });

  it('clears the open-session error when routing a conversation', () => {
    const open = appReducer(initialAppState, { type: 'open-session', sessionId: 'session-1' });
    const failed = appReducer(open, { type: 'session-load-failed', sessionId: 'session-1' });

    expect(failed.openSessionError).toBe(true);
    expect(
      appReducer(failed, {
        type: 'route-conversation',
        threadRootId: 42,
        sessionId: 'session-1',
      }).openSessionError,
    ).toBe(false);
  });

  it('still clears the open thread when selecting a channel', () => {
    const withThread = appReducer(initialAppState, {
      type: 'route-conversation',
      threadRootId: 42,
      sessionId: 'session-1',
    });
    const selected = appReducer(withThread, { type: 'select-channel', channelId: 'channel-2' });

    expect(selected.openThreadRootId).toBeNull();
    expect(selected.openSessionId).toBe('session-1');
  });
});

describe('route-conversation no-op stability', () => {
  it('returns the same state object when the pair and error flag are unchanged', () => {
    const opened = appReducer(initialAppState, { type: 'route-conversation', threadRootId: 42, sessionId: 's-1' });
    const repeat = appReducer(opened, { type: 'route-conversation', threadRootId: 42, sessionId: 's-1' });
    expect(repeat).toBe(opened);
    const cleared = appReducer(opened, { type: 'route-conversation', threadRootId: null, sessionId: null });
    const clearedRepeat = appReducer(cleared, { type: 'route-conversation', threadRootId: null, sessionId: null });
    expect(clearedRepeat).toBe(cleared);
  });
});
