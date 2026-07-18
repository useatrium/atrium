// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '@atrium/surface-client';
import type { Session } from './types';
import { AgentAttentionDialog, AgentAttentionView } from './AgentAttentionView';

const channels = [
  { id: 'engineering', name: 'eng-agents' },
  { id: 'releases', name: 'release-train' },
] as Channel[];

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
    driverName: 'Ada',
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
        questions: [
          {
            id: 'prompt-1',
            header: 'Database',
            question: 'Should I use Postgres or SQLite?',
            options: [
              { label: 'Postgres', description: 'Use the shared database' },
              { label: 'SQLite', description: 'Keep storage local' },
            ],
          },
        ],
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
    render(
      <AgentAttentionView
        sessions={attentionSessions()}
        channels={channels}
        onFocusAgent={() => {}}
        onRetryTurn={() => {}}
        onAnswerQuestion={() => {}}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Blocked questions' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Provider authentication' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Seat requests' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Failed' })).toBeTruthy();
    expect(screen.getByText('Should I use Postgres or SQLite?')).toBeTruthy();
    expect(screen.getByText('GitHub access expired.')).toBeTruthy();
    expect(screen.getByText('Mina requested control of this agent.')).toBeTruthy();
    expect(screen.getByText('#release-train')).toBeTruthy();
    expect(screen.queryByText('#releases')).toBeNull();
    expect(screen.queryByText('Still working')).toBeNull();
    expect(screen.getAllByTestId('glance-chip')).toHaveLength(4);
    expect(screen.getAllByText('Driver: Ada')).toHaveLength(4);
  });

  it('falls back to the raw channel id when the channel is unknown', () => {
    render(
      <AgentAttentionView
        sessions={{
          failed: session({
            id: 'failed',
            channelId: 'ch_01UNKNOWN',
            status: 'failed',
            completedAt: '2026-07-18T11:00:00.000Z',
          }),
        }}
        channels={channels}
        onFocusAgent={() => {}}
        onRetryTurn={() => {}}
        onAnswerQuestion={() => {}}
      />,
    );

    expect(screen.getByText('#ch_01UNKNOWN')).toBeTruthy();
  });

  it('opens the selected agent from its inline action', () => {
    const onFocusAgent = vi.fn();
    render(
      <AgentAttentionView
        sessions={attentionSessions()}
        channels={channels}
        onFocusAgent={onFocusAgent}
        onRetryTurn={() => {}}
        onAnswerQuestion={() => {}}
      />,
    );

    const authRow = screen.getByText('Publish release').closest('li');
    fireEvent.click(within(authRow!).getByRole('button', { name: 'Open →' }));
    expect(onFocusAgent).toHaveBeenCalledWith('auth');
  });

  it('retries failed turns and submits inline question options through their real actions', () => {
    const onRetryTurn = vi.fn();
    const onAnswerQuestion = vi.fn();
    render(
      <AgentAttentionView
        sessions={attentionSessions()}
        channels={channels}
        onFocusAgent={() => {}}
        onRetryTurn={onRetryTurn}
        onAnswerQuestion={onAnswerQuestion}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry turn' }));
    expect(onRetryTurn).toHaveBeenCalledWith('failed');

    fireEvent.click(screen.getByRole('button', { name: 'Postgres' }));
    expect(onAnswerQuestion).toHaveBeenCalledWith('question', 'question-1', {
      'prompt-1': { answers: ['Postgres'] },
    });
  });

  it('collects multi-select option chips before submitting the answer', () => {
    const onAnswerQuestion = vi.fn();
    render(
      <AgentAttentionView
        sessions={{
          question: session({
            id: 'multi-question',
            pendingQuestion: {
              questionId: 'question-2',
              questions: [
                {
                  id: 'prompt-2',
                  header: 'Checks',
                  question: 'Which checks should run?',
                  multiSelect: true,
                  options: [
                    { label: 'Unit', description: 'Run unit tests' },
                    { label: 'E2E', description: 'Run browser tests' },
                  ],
                },
              ],
            },
          }),
        }}
        channels={channels}
        onFocusAgent={() => {}}
        onRetryTurn={() => {}}
        onAnswerQuestion={onAnswerQuestion}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unit' }));
    fireEvent.click(screen.getByRole('button', { name: 'E2E' }));
    expect(onAnswerQuestion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    expect(onAnswerQuestion).toHaveBeenCalledWith('multi-question', 'question-2', {
      'prompt-2': { answers: ['Unit', 'E2E'] },
    });
  });

  it('hides unresolved driver ids instead of rendering them as identities', () => {
    render(
      <AgentAttentionView
        sessions={{
          failed: session({ status: 'failed', completedAt: '2026-07-18T11:00:00.000Z', driverName: undefined }),
        }}
        channels={channels}
        onFocusAgent={() => {}}
        onRetryTurn={() => {}}
        onAnswerQuestion={() => {}}
      />,
    );

    expect(screen.queryByText(/Driver:/)).toBeNull();
    expect(screen.queryByText('user-1')).toBeNull();
  });

  it('shows an empty state when no sessions need attention', () => {
    render(
      <AgentAttentionView
        sessions={{ working: session() }}
        channels={channels}
        onFocusAgent={() => {}}
        onRetryTurn={() => {}}
        onAnswerQuestion={() => {}}
      />,
    );
    expect(screen.getByText('No agents need you.')).toBeTruthy();
  });

  it('filters the list between blocked and failed sessions', () => {
    render(
      <AgentAttentionView
        sessions={attentionSessions()}
        channels={channels}
        onFocusAgent={() => {}}
        onRetryTurn={() => {}}
        onAnswerQuestion={() => {}}
      />,
    );

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

  it('closes on Escape and restores focus to the invoker', async () => {
    const invoker = document.createElement('button');
    document.body.append(invoker);
    invoker.focus();
    const onClose = vi.fn();
    const view = render(
      <AgentAttentionDialog
        sessions={attentionSessions()}
        channels={channels}
        onClose={onClose}
        onFocusAgent={() => {}}
        onRetryTurn={() => {}}
        onAnswerQuestion={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBe(document.activeElement));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();

    view.unmount();
    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });
});
