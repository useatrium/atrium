// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, UserRef, WireEvent } from '@atrium/surface-client';
import { MessageRow } from '../src/components/MessageRow';
import { ThemeProvider } from '../src/theme';

const apiMock = vi.hoisted(() => ({
  getEntryAnnotations: vi.fn(),
  postEntryComment: vi.fn(),
}));

vi.mock('../src/api', () => ({
  api: apiMock,
}));

const me: UserRef = { id: 'u-me', handle: 'me', displayName: 'Me' };
const ada: UserRef = { id: 'u-ada', handle: 'ada', displayName: 'Ada Lovelace' };

type MessageWithHandle = ChatMessage & { handle?: string | null };

function message(over: Partial<MessageWithHandle> = {}): MessageWithHandle {
  return {
    id: 42,
    handle: 'evt_42',
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'annotate me',
    edited: false,
    author: ada,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...over,
  };
}

function comment(
  id: number,
  author: UserRef | null,
  payload: Record<string, unknown>,
): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    type: 'comment.posted',
    actorId: author?.id ?? null,
    payload: { target: 'evt_42', ...payload },
    createdAt: new Date(Date.now() - id * 1000).toISOString(),
    author,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  apiMock.getEntryAnnotations.mockReset();
  apiMock.postEntryComment.mockReset();
});

describe('entry comments on message rows', () => {
  it('lists existing comments and optimistically appends a sent comment', async () => {
    const posted = comment(103, me, { text: 'new note' });
    let resolvePost!: (value: { event: WireEvent }) => void;
    apiMock.getEntryAnnotations.mockResolvedValue({
      comments: [
        comment(101, ada, { text: 'existing note' }),
        comment(102, me, { text: '', deleted: true }),
      ],
      reactions: [],
    });
    apiMock.postEntryComment.mockReturnValue(
      new Promise<{ event: WireEvent }>((resolve) => {
        resolvePost = resolve;
      }),
    );

    render(
      <ThemeProvider>
        <MessageRow message={message()} grouped={false} meId={me.id} />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Comment on entry' }));

    await waitFor(() => expect(apiMock.getEntryAnnotations).toHaveBeenCalledWith('evt_42'));
    const panel = screen.getByRole('dialog', { name: 'Entry comments' });
    expect(await within(panel).findByText('existing note')).toBeTruthy();
    expect(within(panel).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(panel).getByText('@ada')).toBeTruthy();
    expect(within(panel).getByText('Comment deleted')).toBeTruthy();

    const box = screen.getByRole('textbox', { name: 'Comment text' });
    fireEvent.change(box, { target: { value: 'new note' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(within(panel).getByText('new note')).toBeTruthy();
    await waitFor(() =>
      expect(apiMock.postEntryComment).toHaveBeenCalledWith('evt_42', 'new note'),
    );
    resolvePost({ event: posted });
    await waitFor(() => expect(within(panel).getByText('new note')).toBeTruthy());
  });

  it('copies the entry deep link for the row handle', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });
    apiMock.getEntryAnnotations.mockResolvedValue({ comments: [], reactions: [] });

    render(
      <ThemeProvider>
        <MessageRow message={message()} grouped={false} meId={me.id} />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy entry link' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/e/evt_42`),
    );
    expect(screen.getByRole('button', { name: 'Copied entry link' })).toBeTruthy();
  });
});
