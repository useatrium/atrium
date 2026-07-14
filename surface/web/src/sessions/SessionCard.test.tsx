// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import type { Session } from './types';
import { SessionCard } from './SessionCard';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: 42,
    title: 'This task must not appear on the card',
    status: 'completed',
    harness: 'codex',
    repo: 'atrium',
    branch: 'agent-card',
    repos: null,
    spawnedBy: 'u-1',
    spawnerName: 'Ada Lovelace',
    driverId: 'u-1',
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
    costUsd: 0.04,
    resultText: 'The complete agent answer used to be duplicated here.',
    createdAt: '2026-07-05T12:00:00.000Z',
    completedAt: '2026-07-05T12:04:00.000Z',
    archivedAt: null,
    pinned: false,
    lastEventId: 0,
    permalink: '/s/s-1',
    ...overrides,
  };
}

function renderCard(value: Session) {
  render(
    <ThemeProvider>
      <SessionCard session={value} spectators={2} meId="u-1" onOpen={vi.fn()} onOpenPane={vi.fn()} />
    </ThemeProvider>,
  );
}

afterEach(cleanup);

describe('SessionCard terminal states', () => {
  it('collapses a completed run without repeating its title or result', () => {
    renderCard(session());

    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Agent worked 4m')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Show the work →' })).toBeTruthy();
    expect(screen.queryByText('This task must not appear on the card')).toBeNull();
    expect(screen.queryByText('The complete agent answer used to be duplicated here.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });

  // A failed run that DID say why it failed has that text broadcast as a reply
  // message. The card must neither repeat it nor claim a silence that didn't
  // happen — but the recovery actions have to survive either way.
  it('keeps both recovery actions on a failure that reported why, and claims no silence', () => {
    renderCard(session({ status: 'failed' }));

    expect(screen.queryByText('The run ended before reporting a result.')).toBeNull();
    expect(screen.queryByText('The complete agent answer used to be duplicated here.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry turn' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask why' })).toBeTruthy();
  });

  it('names the silence, with both recovery actions, when a failure reported nothing at all', () => {
    renderCard(session({ status: 'failed', resultText: null }));

    expect(screen.getByText('The run ended before reporting a result.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry turn' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask why' })).toBeTruthy();
  });
});
