// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStream } from './useSessionStream';
import { sessionsApi, type SessionStreamCallbacks } from './api';

vi.mock('./api', () => ({
  sessionsApi: {
    openStream: vi.fn(),
  },
}));

const openStream = vi.mocked(sessionsApi.openStream);

describe('useSessionStream', () => {
  let callbacks: SessionStreamCallbacks | null = null;

  beforeEach(() => {
    callbacks = null;
    openStream.mockReset();
    openStream.mockImplementation((_sessionId, _afterEventId, cb) => {
      callbacks = cb;
      return { close: vi.fn() };
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('resets the folded state when the session detaches (sessionId → null)', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useSessionStream(sessionId),
      {
        initialProps: { sessionId: 's-1' as string | null },
      },
    );
    expect(openStream).toHaveBeenCalledTimes(1);

    // Fold one frame so the stream carries visible state.
    await act(async () => {
      callbacks?.onFrame({ event: 'amp_raw_event', event_id: 7, data: {} } as unknown as CentaurEventFrame);
      // Flush the rAF-batched commit (jsdom rAF is setTimeout-backed).
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(result.current.stream.lastEventId).toBe(7);

    // The owning panel re-points to a thread with no attached session: the
    // previous session's folded state must not keep rendering there.
    rerender({ sessionId: null });
    expect(result.current.stream.lastEventId).toBe(0);
    expect(result.current.stream.items).toEqual([]);
    expect(result.current.connected).toBe(false);
    expect(result.current.lastFrameAt).toBeNull();
  });
});
