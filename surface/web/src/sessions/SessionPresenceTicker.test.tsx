// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { appReducer, initialAppState } from '@atrium/surface-client';
import { describe, expect, it } from 'vitest';
import type { Session } from './types';
import { SessionPresenceTicker } from './SessionPresenceTicker';

function session(): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: 1,
    title: 'Ticker',
    status: 'running',
    harness: 'codex',
    repo: null,
    branch: null,
    repos: null,
    spawnedBy: 'u-1',
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
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-05T12:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 0,
    permalink: '/s/s-1',
  };
}

describe('SessionPresenceTicker', () => {
  it('folds WS activity through the store reducer and updates one ticker in place', () => {
    const withSession = { ...initialAppState, sessions: { 's-1': session() } };
    const first = appReducer(withSession, {
      type: 'session-activity',
      sessionId: 's-1',
      summary: 'running: timeline.spec (2/14)',
      at: '2026-07-05T12:01:00.000Z',
    });
    const view = render(<SessionPresenceTicker session={first.sessions['s-1']!} />);
    const ticker = screen.getByTestId('session-presence-ticker');
    expect(ticker.textContent).toContain('running: timeline.spec (2/14)');

    const second = appReducer(first, {
      type: 'session-activity',
      sessionId: 's-1',
      summary: 'editing surface/web/src/components/MessageRow.tsx',
      at: '2026-07-05T12:01:01.000Z',
    });
    view.rerender(<SessionPresenceTicker session={second.sessions['s-1']!} />);
    expect(screen.getByTestId('session-presence-ticker')).toBe(ticker);
    expect(ticker.textContent).toContain('editing surface/web/src/components/MessageRow.tsx');
  });
});
