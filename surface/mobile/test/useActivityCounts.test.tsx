// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useActivityCounts } from '../src/lib/useActivityCounts';

const chatMock = vi.hoisted(() => ({
  api: {
    getActivity: vi.fn(),
    getActivityCounts: vi.fn(),
  },
  state: { sessions: {} },
}));

vi.mock('../src/lib/chat', () => ({ useChat: () => chatMock }));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useActivityCounts', () => {
  it('fetches the lightweight counts route instead of the activity feed', async () => {
    chatMock.api.getActivityCounts.mockResolvedValue({
      attention: 2,
      unread: 3,
    });

    const { result } = renderHook(() => useActivityCounts());

    await waitFor(() => expect(result.current).toEqual({ attention: 2, unread: 3 }));
    expect(chatMock.api.getActivityCounts).toHaveBeenCalled();
    expect(chatMock.api.getActivity).not.toHaveBeenCalled();
  });
});
