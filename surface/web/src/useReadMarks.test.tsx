// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import type { EnqueueOpInput } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReadMarks } from './useReadMarks';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useReadMarks read advance persistence hooks', () => {
  it('notifies onAdvance when a read cursor actually advances', () => {
    const dispatch = vi.fn();
    const enqueueOp = vi.fn(async (_input: EnqueueOpInput<'read.mark'>) => ({ opId: 'op-1' }));
    const onAdvance = vi.fn();

    const { result } = renderHook(() =>
      useReadMarks({
        dispatch,
        enqueueOp,
        onAdvance,
        onApiError: vi.fn(),
        throttleMs: 0,
      }),
    );

    act(() => {
      result.current.markRead('ch-1', 5);
      result.current.markRead('ch-1', 5);
    });

    expect(onAdvance).toHaveBeenCalledOnce();
    expect(onAdvance).toHaveBeenCalledWith('ch-1', 5);
  });

  it('flushes a pending trailing read mark immediately', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3000);
    const dispatch = vi.fn();
    const enqueueOp = vi.fn(async (_input: EnqueueOpInput<'read.mark'>) => ({ opId: 'op-1' }));
    const onAdvance = vi.fn();

    const { result } = renderHook(() =>
      useReadMarks({
        dispatch,
        enqueueOp,
        onAdvance,
        onApiError: vi.fn(),
        throttleMs: 2000,
      }),
    );

    act(() => result.current.markRead('ch-1', 5));
    act(() => {
      vi.setSystemTime(3500);
      result.current.markRead('ch-1', 9);
    });

    expect(enqueueOp).toHaveBeenCalledTimes(1);
    act(() => result.current.flush());

    expect(enqueueOp).toHaveBeenCalledTimes(2);
    expect(enqueueOp).toHaveBeenLastCalledWith(
      expect.objectContaining({
        opType: 'read.mark',
        payload: { channelId: 'ch-1', lastReadEventId: 9 },
      }),
    );
    expect(onAdvance).toHaveBeenLastCalledWith('ch-1', 9);
  });

  it('fires immediately past the throttle when opts.immediate is set', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3000);
    const dispatch = vi.fn();
    const enqueueOp = vi.fn(async (_input: EnqueueOpInput<'read.mark'>) => ({ opId: 'op-1' }));
    const onAdvance = vi.fn();

    const { result } = renderHook(() =>
      useReadMarks({
        dispatch,
        enqueueOp,
        onAdvance,
        onApiError: vi.fn(),
        throttleMs: 2000,
      }),
    );

    // First mark fires (elapsed >= throttle on a cold channel), advancing to 5.
    act(() => result.current.markRead('ch-1', 5));
    // A follow-up within the throttle window would normally trail — immediate bypasses it.
    act(() => {
      vi.setSystemTime(3100);
      result.current.markRead('ch-1', 9, { immediate: true });
    });

    expect(enqueueOp).toHaveBeenCalledTimes(2);
    expect(enqueueOp).toHaveBeenLastCalledWith(
      expect.objectContaining({ opType: 'read.mark', payload: { channelId: 'ch-1', lastReadEventId: 9 } }),
    );
    // An immediate call that does not advance the cursor is a no-op (no server spam).
    act(() => result.current.markRead('ch-1', 9, { immediate: true }));
    expect(enqueueOp).toHaveBeenCalledTimes(2);
  });

  it('beacons the intended cursor for each visited channel on flushBeacon', () => {
    const sendBeacon = vi.fn((_url: string, _body?: BodyInit) => true);
    vi.stubGlobal('navigator', { sendBeacon } as unknown as Navigator);
    const enqueueOp = vi.fn(async (_input: EnqueueOpInput<'read.mark'>) => ({ opId: 'op-1' }));

    const { result } = renderHook(() =>
      useReadMarks({
        dispatch: vi.fn(),
        enqueueOp,
        onApiError: vi.fn(),
        throttleMs: 2000,
      }),
    );

    // A cursor still sitting in a pending throttle timer must still be beaconed:
    // markRead records the intended cursor before the throttle branch.
    act(() => result.current.markRead('ch-1', 5));
    act(() => result.current.markRead('ch-1', 12));
    act(() => result.current.flushBeacon());

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeacon.mock.calls[0]!;
    expect(url).toBe('/api/channels/ch-1/read');
    expect(body).toBeInstanceOf(Blob);
  });
});
