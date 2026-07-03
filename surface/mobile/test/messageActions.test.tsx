// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import type { ChatMessage } from '@atrium/surface-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '../src/components/MessageActions';
import { renderWithTheme } from './rnTestUtils';

const setStringAsync = vi.fn(async (_value: string) => {});
const selectionAsync = vi.fn(async () => {});

vi.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => setStringAsync(value),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: () => selectionAsync(),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

type ActionTarget = ChatMessage & {
  actionCopyText?: string;
};

function message(overrides: Partial<ActionTarget> = {}): ActionTarget {
  return {
    id: 42,
    clientMsgId: null,
    channelId: 'c-1',
    threadRootEventId: null,
    text: 'hello',
    edited: false,
    author: { id: 'u-1', handle: 'riley', displayName: 'Riley' },
    createdAt: '2026-07-03T12:00:00.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...overrides,
  };
}

function renderActions(messageTarget: ActionTarget) {
  return renderWithTheme(
    <MessageActions
      message={messageTarget}
      mine
      canReply
      onClose={vi.fn()}
      onReact={vi.fn()}
      onReply={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe('MessageActions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setStringAsync.mockClear();
    selectionAsync.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('copies visible block text and shows copied feedback before closing', async () => {
    const onClose = vi.fn();
    renderWithTheme(
      <MessageActions
        message={message({
          text: '',
          sessionId: 's-1',
          actionCopyText: 'Fix mobile session actions',
        })}
        mine
        canReply
        onClose={onClose}
        onReact={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }));
    await act(async () => {});

    expect(setStringAsync).toHaveBeenCalledWith('Fix mobile session actions');
    expect(selectionAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not expose message controls for session block targets', () => {
    renderActions(message({ sessionId: 's-1', actionCopyText: 'Agent session' }));

    expect(screen.getByRole('button', { name: 'Copy text' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Comments' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reply in thread' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^React with /)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete message' })).not.toBeInTheDocument();
  });
});
