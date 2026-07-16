// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { ApiError } from '../api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionsApi } from './api';
import { useSessionSeat } from './useSessionSeat';

vi.mock('./api', () => ({
  sessionsApi: {
    requestSeat: vi.fn(),
    takeSeat: vi.fn(),
  },
}));

const requestSeat = vi.mocked(sessionsApi.requestSeat);
const takeSeat = vi.mocked(sessionsApi.takeSeat);

describe('useSessionSeat', () => {
  beforeEach(() => {
    requestSeat.mockReset();
    takeSeat.mockReset();
    requestSeat.mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('falls back to a seat request when takeSeat reports a 409', async () => {
    const reportError = vi.fn();
    takeSeat.mockRejectedValue(new ApiError(409, 'seat_held', 'seat held'));
    const { result } = renderHook(() =>
      useSessionSeat({
        sessionId: 's-1',
        isDriver: false,
        pendingSeatRequests: [],
        meId: 'u-1',
        reportError,
      }),
    );

    act(() => result.current.takeSeat());

    await waitFor(() => expect(requestSeat).toHaveBeenCalledWith('s-1'));
    expect(takeSeat).toHaveBeenCalledWith('s-1');
    expect(result.current.seatAsk).toBe('seat-held');
    expect(result.current.seatRequested).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('auto-resets an unconfirmed take after five seconds', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSessionSeat({
        sessionId: 's-1',
        isDriver: false,
        pendingSeatRequests: [],
        meId: 'u-1',
        reportError: vi.fn(),
      }),
    );

    act(() => result.current.setSeatAsk('confirm-take'));
    expect(result.current.seatAsk).toBe('confirm-take');
    act(() => vi.advanceTimersByTime(4999));
    expect(result.current.seatAsk).toBe('confirm-take');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.seatAsk).toBe('idle');
  });
});
