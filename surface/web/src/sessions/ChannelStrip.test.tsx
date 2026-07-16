// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './types';
import { ChannelStrip } from './ChannelStrip';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    channelId: 'channel-1',
    threadRootEventId: null,
    title: 'Agent work',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-1',
    driverId: 'u-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-15T12:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/s/session-1',
    ...overrides,
  };
}

afterEach(cleanup);

describe('ChannelStrip', () => {
  it('uses server channel counts for the collapsed summary instead of local session derivation', () => {
    render(
      <ChannelStrip
        channelId="channel-1"
        channelCounts={{ needsYou: 4, running: 3, toReview: 2 }}
        sessions={{ onlyRunning: session() }}
        onOpenSession={vi.fn()}
        onOpenInbox={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Agent work in this channel: 4 needs you, 3 running, 2 to review' }),
    ).toBeTruthy();
  });

  it('caps locally known terminal rows to the server review count', () => {
    render(
      <ChannelStrip
        channelId="channel-1"
        channelCounts={{ needsYou: 0, running: 0, toReview: 1 }}
        sessions={{
          older: session({
            id: 'older',
            title: 'Older terminal work',
            status: 'completed',
            completedAt: '2026-07-14T12:00:00.000Z',
          }),
          newer: session({
            id: 'newer',
            title: 'Newer terminal work',
            status: 'completed',
            completedAt: '2026-07-15T12:00:00.000Z',
          }),
        }}
        onOpenSession={vi.fn()}
        onOpenInbox={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Agent work in this channel: 1 to review' }));
    expect(screen.getByTestId('channel-strip-row-newer')).toBeTruthy();
    expect(screen.queryByTestId('channel-strip-row-older')).toBeNull();
  });

  it('never admits fold-only sessions to the terminal review rows', () => {
    render(
      <ChannelStrip
        channelId="channel-1"
        channelCounts={{ needsYou: 0, running: 0, toReview: 1 }}
        sessions={{
          unknown: session({
            id: 'unknown',
            title: 'Fold-only phantom',
            status: 'unknown' as Session['status'],
            createdAt: new Date().toISOString(),
          }),
          completed: session({
            id: 'completed',
            title: 'Durably completed work',
            status: 'completed',
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            completedAt: new Date().toISOString(),
          }),
        }}
        onOpenSession={vi.fn()}
        onOpenInbox={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Agent work in this channel: 1 to review' }));
    expect(screen.getByTestId('channel-strip-row-completed')).toBeTruthy();
    expect(screen.queryByTestId('channel-strip-row-unknown')).toBeNull();
  });
});
