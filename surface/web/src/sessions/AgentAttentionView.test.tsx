// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './types';
import { AgentAttentionView } from './AgentAttentionView';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    channelId: 'engineering',
    threadRootEventId: null,
    title: 'Agent session',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'user-1',
    driverId: 'user-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/s/session-1',
    ...overrides,
  };
}

function attentionSessions(): Record<string, Session> {
  return {
    question: session({
      id: 'question',
      title: 'Choose database',
      pendingQuestion: {
        questionId: 'question-1',
        askedAt: '2026-07-18T09:00:00.000Z',
        questions: [{ id: 'prompt-1', header: 'Database', question: 'Should I use Postgres or SQLite?' }],
      },
    }),
    auth: session({
      id: 'auth',
      title: 'Publish release',
      channelId: 'releases',
      providerAuthRequired: {
        provider: 'github',
        userId: 'user-1',
        reason: 'invalid_token',
        message: 'GitHub access expired.',
        at: '2026-07-18T09:30:00.000Z',
      },
    }),
    seat: session({
      id: 'seat',
      title: 'Pair on migration',
      pendingSeatRequests: [{ userId: 'user-2', displayName: 'Mina' }],
    }),
    failed: session({
      id: 'failed',
      title: 'Deploy preview',
      status: 'failed',
      resultText: 'Preview deployment failed.',
      completedAt: '2026-07-18T11:00:00.000Z',
    }),
    working: session({ id: 'working', title: 'Still working' }),
  };
}

afterEach(cleanup);

describe('AgentAttentionView', () => {
  it('lists needs-you sessions grouped by reason with their waiting details', () => {
    render(<AgentAttentionView sessions={attentionSessions()} onFocusAgent={() => {}} />);

    expect(screen.getByRole('heading', { name: 'Blocked questions' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Provider authentication' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Seat requests' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Failed' })).toBeTruthy();
    expect(screen.getByText('Should I use Postgres or SQLite?')).toBeTruthy();
    expect(screen.getByText('GitHub access expired.')).toBeTruthy();
    expect(screen.getByText('Mina requested control of this agent.')).toBeTruthy();
    expect(screen.getByText('#releases')).toBeTruthy();
    expect(screen.queryByText('Still working')).toBeNull();
    expect(screen.getAllByTestId('glance-chip')).toHaveLength(4);
  });

  it('opens the selected agent from its inline action', () => {
    const onFocusAgent = vi.fn();
    render(<AgentAttentionView sessions={attentionSessions()} onFocusAgent={onFocusAgent} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect →' }));
    expect(onFocusAgent).toHaveBeenCalledWith('auth');
  });

  it('shows an empty state when no sessions need attention', () => {
    render(<AgentAttentionView sessions={{ working: session() }} onFocusAgent={() => {}} />);
    expect(screen.getByText('No agents need you.')).toBeTruthy();
  });

  it('filters the list between blocked and failed sessions', () => {
    render(<AgentAttentionView sessions={attentionSessions()} onFocusAgent={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    expect(screen.getByText('Deploy preview')).toBeTruthy();
    expect(screen.queryByText('Choose database')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Blocked' }));
    expect(screen.queryByText('Deploy preview')).toBeNull();
    expect(screen.getByText('Choose database')).toBeTruthy();
    expect(screen.getByText('Publish release')).toBeTruthy();
    expect(screen.getByText('Pair on migration')).toBeTruthy();

    const filters = screen.getByLabelText('Filter agent attention');
    expect(within(filters).getByRole('button', { name: 'Blocked' }).getAttribute('aria-pressed')).toBe('true');
  });
});
