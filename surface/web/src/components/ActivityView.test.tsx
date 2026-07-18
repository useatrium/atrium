// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ActivityItem } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ThemeProvider } from '../theme';
import { ActivityView } from './ActivityView';

const mention: ActivityItem = {
  kind: 'mention',
  eventId: '41',
  channelId: 'ch-1',
  channelName: 'engineering',
  actorId: 'u-2',
  actorName: 'Grace',
  snippet: 'Can you review this?',
  createdAt: '2026-07-05T12:00:00.000Z',
  sessionId: null,
  sessionTitle: null,
  sessionStatus: null,
  attention: false,
  unread: true,
};

const agentResult: ActivityItem = {
  ...mention,
  kind: 'session_failed',
  eventId: '42',
  snippet: 'The run failed',
  sessionId: 's-1',
  sessionTitle: 'Timeline migration',
  sessionStatus: 'failed',
  attention: true,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ActivityView people feed', () => {
  it('shows people activity, excludes agent shelves and reports people-only counts', async () => {
    vi.spyOn(api, 'getActivity').mockResolvedValue({
      items: [{ ...agentResult, kind: 'seat_request', eventId: '43' }, agentResult, mention],
      nextCursor: null,
      lastReadEventId: '0',
      unreadExceptionIds: [],
      counts: { attention: 1, unread: 2, needsYou: 1, running: 0, toReview: 1 },
      channelCounts: {},
    });
    vi.spyOn(api, 'markActivityItemRead').mockResolvedValue({ lastReadEventId: '41', unreadExceptionIds: [] });
    const onCountsChange = vi.fn();
    const onSelectChannel = vi.fn();

    render(
      <ThemeProvider>
        <ActivityView onSelectChannel={onSelectChannel} onCountsChange={onCountsChange} />
      </ThemeProvider>,
    );

    const row = await screen.findByRole('button', { name: /^Unread, Grace mentioned you/ });
    expect(screen.queryByText('Timeline migration failed')).toBeNull();
    expect(screen.queryByText(/wants to drive/)).toBeNull();
    expect(screen.queryByText(/Needs you|Running|To review/)).toBeNull();
    expect(onCountsChange).toHaveBeenCalledWith({ attention: 0, unread: 1, needsYou: 0, running: 0, toReview: 0 });

    fireEvent.click(row);
    expect(onSelectChannel).toHaveBeenCalledWith('ch-1');
  });
});
