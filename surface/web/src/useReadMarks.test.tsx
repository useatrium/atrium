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
});
