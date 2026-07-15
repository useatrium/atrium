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
});
