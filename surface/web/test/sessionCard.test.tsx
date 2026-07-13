// @vitest-environment jsdom
// (a) The session card transitions across session.* WS events without refetch.

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appReducer, initialAppState, type AppState } from '@atrium/surface-client';
import { SessionCard } from '../src/sessions/SessionCard';
import { sessionsApi } from '../src/sessions/api';
import type { WireEvent } from '@atrium/surface-client';

beforeEach(() => {
  vi.spyOn(sessionsApi, 'listPresentations').mockResolvedValue({ presentations: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

/** The glance chip's text ("Working · starting", "Needs you · 12m", …). */
function chipText(): string {
  return screen.getByTestId('glance-chip').textContent ?? '';
}

describe('session card transitions across session.* events', () => {
  it('spawned → status_changed → completed updates chip, excerpt, permalink', () => {
    let s = spawned(loadedState());

    // The spawned event placed a card row in the timeline like a message.
    expect(s.timelines[CH]!.main.map((m) => m.sessionId)).toEqual(['sess-1']);
    expect(s.sessions['sess-1']!.spawnerName).toBe('Kay');

    const { rerender } = render(cardFor(s));
    expect(chipText()).toContain('starting');
    expect(screen.getByText('fix the flaky build')).toBeTruthy();

    s = appReducer(s, {
      type: 'server-event',
      event: wire(102, 'session.status_changed', { sessionId: 'sess-1', status: 'queued' }),
    });
    rerender(cardFor(s));
    expect(chipText()).toContain('Working');
    expect(chipText()).toContain('starting');

    s = appReducer(s, {
      type: 'server-event',
      event: wire(103, 'session.status_changed', { sessionId: 'sess-1', status: 'running' }),
    });
    rerender(cardFor(s));
    expect(chipText()).toContain('Working');
    expect(chipText()).not.toContain('starting');
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
    expect(chipText()).toContain('Done');
    expect(screen.getByText(/All green: 12 tests passed/)).toBeTruthy();
    expect(screen.getByText('Open session').getAttribute('href')).toBe('/s/sess-1');
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
    expect(chipText()).toContain('Failed');
    expect(screen.getByText(/harness crashed/)).toBeTruthy();
  });

  it('shows needs auth when Claude auth is required', () => {
    let s = spawned(loadedState());
    s = appReducer(s, {
      type: 'server-event',
      event: wire(102, 'session.provider_auth_required', {
        sessionId: 'sess-1',
        provider: 'claude-code',
        userId: spawner.id,
        reason: 'invalid_token',
        message: 'Claude Code authentication failed.',
        at: new Date().toISOString(),
      }),
    });
    render(cardFor(s));
    expect(chipText()).toContain('Needs you');
    expect(chipText()).toContain('needs auth');
    expect(s.sessions['sess-1']!.providerAuthRequired).toMatchObject({
      provider: 'claude-code',
      reason: 'invalid_token',
    });
  });

  it('preserves GitHub auth-required state across terminal checkout failure', () => {
    let s = spawned(loadedState());
    s = appReducer(s, {
      type: 'server-event',
      event: wire(102, 'session.github_auth_required', {
        sessionId: 'sess-1',
        provider: 'github',
        userId: spawner.id,
        reason: 'invalid_token',
        message: 'GitHub authentication failed.',
        at: new Date().toISOString(),
      }),
    });
    s = appReducer(s, {
      type: 'server-event',
      event: wire(103, 'session.completed', {
        sessionId: 'sess-1',
        status: 'failed',
        resultExcerpt: 'private repo checkout failed',
        permalink: '/s/sess-1',
      }),
    });

    expect(s.sessions['sess-1']!.providerAuthRequired).toMatchObject({
      provider: 'github',
      reason: 'invalid_token',
      message: 'GitHub authentication failed.',
    });
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

  it('renders generated app presentations under the timeline session card', async () => {
    vi.mocked(sessionsApi.listPresentations).mockResolvedValue({
      presentations: [
        {
          id: 'artifact-presented:shared/apps/support-triage-console/index.html',
          presentationId: 'presentation-1',
          version: 2,
          appSlug: 'support-triage-console',
          path: 'shared/apps/support-triage-console/index.html',
          title: 'Support Triage Console',
          renderer: 'html-app',
          description: 'Embedded support queue demo.',
          previewUrl: 'preview.html?preview=1',
          previewSizePolicy: { enabled: true, defaultSize: 'card' },
          statePolicy: { mode: 'isolated' },
          executionId: null,
          sourceEventIds: [],
        },
      ],
    });
    const state = appReducer(spawned(loadedState()), {
      type: 'server-event',
      event: wire(104, 'session.completed', {
        sessionId: 'sess-1',
        status: 'completed',
        resultExcerpt: 'Built app.',
        permalink: '/s/sess-1',
      }),
    });

    render(cardFor(state));

    await waitFor(() => expect(screen.getByTestId('app-presentation-card')).toBeTruthy());
    expect(screen.getByText('Support Triage Console')).toBeTruthy();
    expect(screen.queryByText('Embedded support queue demo.')).toBeNull();
    expect(screen.queryByText('html-app')).toBeNull();
    expect(screen.queryByText('v2')).toBeNull();
    const frame = screen.getByTitle('Support Triage Console preview') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toContain('path=shared%2Fapps%2Fsupport-triage-console%2Fpreview.html');
    expect(frame.getAttribute('src')).toContain('preview=1');
    expect(frame.className).toContain('h-[28rem]');
  });
});
