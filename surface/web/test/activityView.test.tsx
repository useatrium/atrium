// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityView } from '../src/components/ActivityView';

const apiMock = vi.hoisted(() => ({
  getActivity: vi.fn(),
  messages: vi.fn(),
}));

vi.mock('../src/api', () => ({
  api: apiMock,
}));

afterEach(cleanup);

beforeEach(() => {
  apiMock.getActivity.mockReset();
  apiMock.messages.mockReset();
});

describe('ActivityView', () => {
  it('renders activity, paginates, and dispatches click destinations', async () => {
    const onSelectChannel = vi.fn();
    const onOpenSession = vi.fn();
    apiMock.getActivity
      .mockResolvedValueOnce({
        items: [
          {
            eventId: '12',
            kind: 'agent_question',
            channelId: 'ch-agent',
            channelName: 'general',
            actorId: 'u-me',
            actorName: 'Me',
            snippet: 'Deploy now?',
            createdAt: new Date().toISOString(),
          },
          {
            eventId: '9',
            kind: 'mention',
            channelId: 'ch-public',
            channelName: 'general',
            actorId: 'u-alice',
            actorName: 'Alice',
            snippet: 'hello @me',
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: '9',
      })
      .mockResolvedValueOnce({
        items: [
          {
            eventId: '5',
            kind: 'dm',
            channelId: 'ch-dm',
            channelName: 'dm-alice',
            actorId: 'u-alice',
            actorName: 'Alice',
            snippet: 'direct hello',
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      });
    apiMock.messages.mockResolvedValue({
      events: [
        {
          id: 12,
          workspaceId: 'ws-1',
          channelId: 'ch-agent',
          threadRootEventId: 1,
          type: 'session.question_requested',
          actorId: 'u-me',
          payload: { sessionId: 's-1' },
          createdAt: new Date().toISOString(),
        },
      ],
      hasMore: false,
    });

    render(<ActivityView onSelectChannel={onSelectChannel} onOpenSession={onOpenSession} />);

    expect(await screen.findByText('Agent needs your input')).toBeTruthy();
    expect(screen.getByText('Alice mentioned you')).toBeTruthy();

    fireEvent(
      screen.getByText('Alice mentioned you'),
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(onSelectChannel).toHaveBeenCalledWith('ch-public');
    expect(apiMock.messages).not.toHaveBeenCalled();

    fireEvent(
      screen.getByText('Agent needs your input'),
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('s-1'));
    expect(onSelectChannel).toHaveBeenCalledWith('ch-agent');

    fireEvent(
      screen.getByRole('button', { name: 'Load more' }),
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await screen.findByText('Alice sent a DM');
    expect(apiMock.getActivity).toHaveBeenLastCalledWith('9');
  });
});
