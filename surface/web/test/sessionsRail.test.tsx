// @vitest-environment jsdom
// SessionsRail groups a channel's sessions into Needs you / Active / Recent,
// scopes to the active channel, and opens a card as a peek.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionsRail } from '../src/sessions/SessionsRail';
import type { Session } from '../src/sessions/types';

const me = { id: 'u-me', handle: 'me', displayName: 'Me' };

let seq = 0;
function session(overrides: Partial<Session> = {}): Session {
  seq += 1;
  return {
    id: `s-${seq}`,
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: `task ${seq}`,
    status: 'running',
    harness: 'claude-code',
    spawnedBy: me.id,
    spawnerName: me.displayName,
    driverId: null,
    archivedAt: null,
    pinned: false,
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    completedAt: null,
    lastEventId: 0,
    permalink: `/s/s-${seq}`,
    ...overrides,
  };
}

function asMap(...sessions: Session[]): Record<string, Session> {
  return Object.fromEntries(sessions.map((s) => [s.id, s]));
}

afterEach(cleanup);

describe('SessionsRail', () => {
  it('groups into Needs you / Active / Recent and scopes to the channel', () => {
    const needs = session({
      title: 'awaiting answer',
      status: 'running',
      pendingQuestion: { questionId: 'q1', questions: [] },
    });
    const active = session({ title: 'still working', status: 'running' });
    const done = session({ title: 'finished up', status: 'completed', completedAt: new Date().toISOString() });
    const other = session({ title: 'other channel', channelId: 'ch-2' });

    render(
      <SessionsRail
        channelId="ch-1"
        sessions={asMap(needs, active, done, other)}
        onOpenSession={() => {}}
      />,
    );

    expect(screen.getByText('Needs you')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getByText('awaiting answer')).toBeTruthy();
    expect(screen.getByText('still working')).toBeTruthy();
    expect(screen.getByText('finished up')).toBeTruthy();
    // Other channel's session is excluded.
    expect(screen.queryByText('other channel')).toBeNull();
    // Total count badge.
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('shows an empty state when the channel has no sessions', () => {
    render(
      <SessionsRail channelId="ch-1" sessions={{}} onOpenSession={() => {}} />,
    );
    expect(screen.getByText('No sessions yet')).toBeTruthy();
    expect(screen.queryByText('Active')).toBeNull();
  });

  it('opens a card as a peek', () => {
    const onOpen = vi.fn();
    const s = session({ title: 'open me' });
    render(<SessionsRail channelId="ch-1" sessions={asMap(s)} onOpenSession={onOpen} />);
    fireEvent.click(screen.getByText('open me'));
    expect(onOpen).toHaveBeenCalledWith(s.id);
  });
});
