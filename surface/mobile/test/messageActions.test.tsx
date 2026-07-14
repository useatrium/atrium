// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { Text } from 'react-native';
import type { ChatMessage } from '@atrium/surface-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions, MessageActionSheet } from '../src/components/MessageActions';
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

vi.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => <Text>{name}</Text>,
  MaterialCommunityIcons: ({ name }: { name: string }) => <Text>{name}</Text>,
}));

type ActionTarget = ChatMessage & {
  actionCopyText?: string;
  actionCopyLink?: string;
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

  it('copies block links and shows copied feedback before closing', async () => {
    const onClose = vi.fn();
    renderWithTheme(
      <MessageActions
        message={message({
          sessionId: 's-1',
          actionCopyText: 'Agent session',
          actionCopyLink: 'http://127.0.0.1:3104/e/evt_42',
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

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await act(async () => {});

    expect(setStringAsync).toHaveBeenCalledWith('http://127.0.0.1:3104/e/evt_42');
    expect(selectionAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Copied link' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders a transcript action list without reactions when reaction props are omitted', () => {
    const onClose = vi.fn();
    const onCopy = vi.fn();
    const onDiscuss = vi.fn();

    renderWithTheme(
      <MessageActionSheet
        visible
        onClose={onClose}
        actions={[
          { key: 'copy-text', label: 'Copy text', onSelect: onCopy },
          { key: 'discuss', label: 'Discuss in thread', onSelect: onDiscuss },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }));

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Discuss in thread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^React with /)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open reaction picker' })).not.toBeInTheDocument();
  });
});
