// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ActivityItem } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { Session } from '../sessions/types';
import { ThemeProvider } from '../theme';
import { ActivityView } from './ActivityView';

const session: Session = {
  id: 's-1',
  workspaceId: 'ws-1',
  channelId: 'ch-1',
  threadRootEventId: 42,
  title: 'Timeline migration',
  status: 'failed',
  harness: 'codex',
  repo: null,
  branch: null,
  repos: null,
  spawnedBy: 'u-1',
  driverId: 'u-1',
  driverName: 'Ada Lovelace',
  pendingSeatRequests: [],
  suggestions: [],
  answerProposals: [],
  pendingQuestion: null,
  providerAuthRequired: null,
  githubIdentityMode: null,
  providerConnectionId: null,
  agentProfileVersionId: null,
  modelEffort: null,
  questionEvents: [],
  seatEvents: [],
  costUsd: 0,
  resultText: null,
  createdAt: '2026-07-05T12:00:00.000Z',
  completedAt: '2026-07-05T12:00:30.000Z',
  archivedAt: null,
  pinned: false,
  lastEventId: 42,
  permalink: '/s/s-1',
};

const item: ActivityItem = {
  kind: 'session_failed',
  eventId: '42',
  channelId: 'ch-1',
  channelName: 'engineering',
  actorId: null,
  actorName: null,
  snippet: 'The run failed',
  createdAt: '2026-07-05T12:00:30.000Z',
  sessionId: 's-1',
  sessionTitle: 'Timeline migration',
  sessionStatus: 'failed',
  attention: false,
  unread: true,
};

function mockActivity() {
  return vi.spyOn(api, 'getActivity').mockResolvedValue({
    items: [item],
    nextCursor: null,
    lastReadEventId: '0',
    unreadExceptionIds: [],
    counts: { attention: 0, unread: 1, needsYou: 0, running: 0, toReview: 1 },
    channelCounts: {},
  });
}

afterEach(() => cleanup());

describe('ActivityView failed session nudges', () => {
  it('shows to spectators, emits the canonical thread payload, and confirms optimistically', async () => {
    mockActivity();
    const onNudge = vi.fn();
    render(
      <ThemeProvider>
        <ActivityView
          onSelectChannel={vi.fn()}
          onOpenSession={vi.fn()}
          sessions={{ 's-1': session }}
          meId="u-2"
          onNudge={onNudge}
        />
      </ThemeProvider>,
    );
    const nudge = await screen.findByRole('button', { name: 'Nudge Ada Lovelace about Timeline migration' });
    fireEvent.click(nudge);
    expect(onNudge).toHaveBeenCalledWith({
      channelId: 'ch-1',
      threadRootEventId: 42,
      text: '<@u-1> this run failed — worth a retry?',
      driverName: 'Ada Lovelace',
      title: 'Timeline migration',
    });
    expect(nudge.textContent).toContain('Nudged ✓');
  });

  it('does not show to the driver or when the session is completed', async () => {
    mockActivity();
    const { rerender } = render(
      <ThemeProvider>
        <ActivityView onSelectChannel={vi.fn()} onOpenSession={vi.fn()} sessions={{ 's-1': session }} meId="u-1" />
      </ThemeProvider>,
    );
    await screen.findByText('Timeline migration failed');
    expect(screen.queryByRole('button', { name: /Nudge/ })).toBeNull();
    rerender(
      <ThemeProvider>
        <ActivityView
          onSelectChannel={vi.fn()}
          onOpenSession={vi.fn()}
          sessions={{ 's-1': { ...session, status: 'completed' } }}
          meId="u-2"
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: /Nudge/ })).toBeNull();
  });
});
