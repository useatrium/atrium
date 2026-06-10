// @vitest-environment jsdom
// (a) The session card transitions across session.* WS events without refetch.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { appReducer, initialAppState, type AppState } from '../src/appState';
import { SessionCard } from '../src/sessions/SessionCard';
import type { WireEvent } from '../src/state';

afterEach(cleanup);

const spawner = { id: 'u-kay', handle: 'kay', displayName: 'Kay' };
const CH = 'ch-1';

function wire(id: number, type: string, payload: Record<string, unknown>): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId: CH,
    threadRootEventId: null,
    type,
    actorId: spawner.id,
    payload,
    // Recent timestamps, ordered by id — ancient createdAt would (correctly)
    // render non-terminal sessions as stalled.
    createdAt: new Date(Date.now() - (200 - id) * 1000).toISOString(),
    author: spawner,
  };
}

function loadedState(): AppState {
  return appReducer(initialAppState, {
    type: 'history-loaded',
    channelId: CH,
    events: [],
    hasMore: false,
  });
}

function spawned(state: AppState): AppState {
  return appReducer(state, {
    type: 'server-event',
    event: wire(101, 'session.spawned', {
      sessionId: 'sess-1',
      title: 'fix the flaky build',
      harness: 'claude-code',
      by: spawner.id,
    }),
  });
}

function cardFor(state: AppState) {
  const session = state.sessions['sess-1'];
  if (!session) throw new Error('session entity missing');
  return <SessionCard session={session} spectators={0} onOpenPane={() => {}} />;
}

describe('session card transitions across session.* events', () => {
  it('spawned → status_changed → completed updates chip, excerpt, permalink', () => {
    let s = spawned(loadedState());

    // The spawned event placed a card row in the timeline like a message.
    expect(s.timelines[CH]!.main.map((m) => m.sessionId)).toEqual(['sess-1']);
    expect(s.sessions['sess-1']!.spawnerName).toBe('Kay');

    const { rerender } = render(cardFor(s));
    expect(screen.getByText('starting')).toBeTruthy();
    expect(screen.getByText('fix the flaky build')).toBeTruthy();

    s = appReducer(s, {
      type: 'server-event',
      event: wire(102, 'session.status_changed', { sessionId: 'sess-1', status: 'queued' }),
    });
    rerender(cardFor(s));
    expect(screen.getByText('queued')).toBeTruthy();

    s = appReducer(s, {
      type: 'server-event',
      event: wire(103, 'session.status_changed', { sessionId: 'sess-1', status: 'running' }),
    });
    rerender(cardFor(s));
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.queryByText('permalink')).toBeNull();

    s = appReducer(s, {
      type: 'server-event',
      event: wire(104, 'session.completed', {
        sessionId: 'sess-1',
        status: 'completed',
        resultExcerpt: 'All green: 12 tests passed.',
        permalink: '/s/sess-1',
      }),
    });
    rerender(cardFor(s));
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByText(/All green: 12 tests passed/)).toBeTruthy();
    expect(screen.getByText('permalink').getAttribute('href')).toBe('/s/sess-1');
  });

  it('renders a failed terminal state from session.completed', () => {
    let s = spawned(loadedState());
    s = appReducer(s, {
      type: 'server-event',
      event: wire(102, 'session.completed', {
        sessionId: 'sess-1',
        status: 'failed',
        resultExcerpt: 'harness crashed',
        permalink: '/s/sess-1',
      }),
    });
    render(cardFor(s));
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText(/harness crashed/)).toBeTruthy();
  });

  it('shows the current driver in the subtitle when it differs from the spawner', () => {
    const bob = { id: 'u-bob', handle: 'bob', displayName: 'Bob' };
    let s = spawned(loadedState());
    const { rerender } = render(cardFor(s));
    // Driver defaults to the spawner → no separate driver chip.
    expect(screen.queryByText(/driver:/)).toBeNull();

    s = appReducer(s, {
      type: 'server-event',
      event: {
        ...wire(105, 'session.seat_changed', {
          sessionId: 'sess-1',
          from: spawner.id,
          to: bob.id,
          reason: 'taken',
        }),
        actorId: bob.id,
        author: bob,
      },
    });
    rerender(cardFor(s));
    expect(screen.getByText('driver: Bob')).toBeTruthy();

    // Seat returns to the spawner → subtitle drops the driver again.
    s = appReducer(s, {
      type: 'server-event',
      event: {
        ...wire(106, 'session.seat_changed', {
          sessionId: 'sess-1',
          from: bob.id,
          to: spawner.id,
          reason: 'granted',
        }),
        actorId: bob.id,
        author: bob,
      },
    });
    rerender(cardFor(s));
    expect(screen.queryByText(/driver:/)).toBeNull();
    expect(s.sessions['sess-1']!.seatEvents).toHaveLength(2);
  });

  it('ignores status events for unknown sessions and duplicate event ids', () => {
    let s = spawned(loadedState());
    const before = s.sessions;
    s = appReducer(s, {
      type: 'server-event',
      event: wire(110, 'session.status_changed', { sessionId: 'sess-ghost', status: 'running' }),
    });
    expect(s.sessions).toBe(before);
    // Same spawned event again (WS + catch-up overlap) — still one card row.
    s = appReducer(s, {
      type: 'server-event',
      event: wire(101, 'session.spawned', {
        sessionId: 'sess-1',
        title: 'fix the flaky build',
        harness: 'claude-code',
        by: spawner.id,
      }),
    });
    expect(s.timelines[CH]!.main).toHaveLength(1);
  });
});
