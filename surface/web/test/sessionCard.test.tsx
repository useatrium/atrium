// @vitest-environment jsdom
// (a) The session card transitions across session.* WS events without refetch.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('spawned → status_changed → completed updates chip and permalink without echoed content', () => {
    let s = spawned(loadedState());

    // The spawned event placed a card row in the timeline like a message.
    expect(s.timelines[CH]!.main.map((m) => m.sessionId)).toEqual(['sess-1']);
    expect(s.sessions['sess-1']!.spawnerName).toBe('Kay');

    const { rerender } = render(cardFor(s));
    expect(chipText()).toContain('starting');
    expect(screen.queryByText('fix the flaky build')).toBeNull();

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
    expect(screen.queryByText(/All green: 12 tests passed/)).toBeNull();
    expect(screen.getByText(/Agent worked/)).toBeTruthy();
    expect(screen.getByText('Show the work →').getAttribute('href')).toBe('/s/sess-1');
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
    expect(screen.getByText(/Agent failed after/)).toBeTruthy();
    // The failure text rides in on the broadcast reply message, so the card
    // neither duplicates it nor pretends the run said nothing.
    expect(screen.queryByText(/harness crashed/)).toBeNull();
    expect(screen.queryByText('The run ended before reporting a result.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Session details' })).toBeTruthy();
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

  it('flips the card to an answerable question while one is pending', () => {
    let s = spawned(loadedState());
    s = appReducer(s, {
      type: 'server-event',
      event: wire(102, 'session.question_requested', {
        sessionId: 'sess-1',
        questionId: 'q-1',
        questions: [
          {
            id: 'q1',
            header: 'Write lock',
            question: 'Run it now or schedule for tonight?',
            options: [
              { label: 'Run now', description: 'blocks writes' },
              { label: 'Tonight', description: 'quiet window' },
            ],
          },
        ],
      }),
    });
    render(cardFor(s));
    expect(chipText()).toContain('Needs you');
    expect(screen.getByText('Run it now or schedule for tonight?')).toBeTruthy();
    // The flip IS the canonical QuestionCard: options with visible
    // descriptions plus one verb (this viewer isn't the driver, so their
    // submission files an answer proposal).
    expect(screen.getByTestId('question-banner')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Run now/ })).toBeTruthy();
    expect(screen.getByText('blocks writes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Propose answer' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Session details' }));
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

  it('reads the meta row as a sentence on one non-wrapping line', () => {
    const s = spawned(loadedState());
    render(cardFor(s));
    const disclosure = screen.getByRole('button', { name: 'Session details' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('by Kay')).toBeNull();
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');

    // Every token names itself — "Kay · claude-code · 8:35 AM" was token soup.
    expect(screen.getByText('by Kay')).toBeTruthy();
    expect(screen.getByText('claude-code agent')).toBeTruthy();
    expect(screen.getByText(/^started /)).toBeTruthy();

    // One line on a phone: the row never wraps.
    const meta = screen.getByText('by Kay').parentElement;
    expect(meta?.className).toContain('whitespace-nowrap');
    expect(meta?.className).not.toContain('flex-wrap');
  });

  /**
   * The row must give up space in order of IMPORTANCE, not in whatever order
   * flexbox finds convenient. The first cut of this shipped the exact inverse —
   * the author shredded to "b…" while "claude-code agent" boilerplate survived
   * whole — and a class-name-only assertion happily passed it. So: pin the
   * shrink priority itself, which is the thing that was actually wrong.
   */
  it('sheds the meta row by importance: repo first, then boilerplate, never the author', () => {
    const s = spawned(loadedState());
    render(cardFor(s));
    fireEvent.click(screen.getByRole('button', { name: 'Session details' }));

    // The author is the headline. It must be structurally incapable of truncating.
    const author = screen.getByText('by Kay');
    expect(author.className.split(' ')).toContain('shrink-0');
    expect(author.className.split(' ')).not.toContain('truncate');
    expect(author.className.split(' ')).not.toContain('min-w-0');

    // The start time likewise holds its ground.
    const started = screen.getByText(/^started /);
    expect(started.className.split(' ')).toContain('shrink-0');
    expect(started.className.split(' ')).not.toContain('truncate');

    // The long, low-information harness label is what yields space.
    const harness = screen.getByText('claude-code agent');
    expect(harness.className).toContain('truncate');
    expect(harness.className).toContain('shrink-[3]');
  });

  it('drops the repo below sm rather than ellipsizing it to a useless stub', () => {
    let s = spawned(loadedState());
    s = appReducer(s, {
      type: 'server-event',
      event: wire(102, 'session.spawned', {
        sessionId: 'sess-2',
        title: 'migrate thumbnails',
        harness: 'claude-code',
        repo: 'meridian/atlas-infra',
        branch: 'main',
        by: spawner.id,
      }),
    });
    const session = s.sessions['sess-2']!;
    expect(session.repo).toBe('meridian/atlas-infra');
    render(<SessionCard session={session} spectators={0} onOpenPane={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session details' }));

    // "meri…" is pure noise — it's on the card's other rows and in the pane.
    // Below sm the repo is gone entirely, not ellipsized to a stub.
    const repo = screen.getByText('meridian/atlas-infra@main');
    expect(repo.className.split(' ')).toContain('hidden');
    expect(repo.className).toContain('sm:inline');
  });

  it('gives the card actions a 44px tap target on coarse pointers only', () => {
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
    const session = s.sessions['sess-1']!;
    render(<SessionCard session={session} spectators={0} meId={spawner.id} onOpenPane={() => {}} />);

    // WCAG 2.5.8: a 14px line of text is not a tap target. Touch grows them to
    // 44px; a mouse still sees the quiet links they were.
    for (const testid of ['card-retry-turn', 'card-ask-why']) {
      const action = screen.getByTestId(testid);
      expect(action.className).toContain('[@media(pointer:coarse)]:min-h-11');
      // …and only there — no unconditional height that would bulk up the desktop card.
      expect(action.className.split(' ')).not.toContain('min-h-11');
    }
    expect(screen.getByText('Show the work →').className).toContain('[@media(pointer:coarse)]:min-h-11');
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

    // Feed altitude: the app arrives as a compact chip, not a full render.
    await waitFor(() => expect(screen.getByTestId('app-presentation-chip')).toBeTruthy());
    expect(screen.getByText('Support Triage Console')).toBeTruthy();
    expect(screen.queryByTestId('app-presentation-card')).toBeNull();

    // One click opens the full preview in place; Collapse folds it back.
    fireEvent.click(screen.getByTestId('app-presentation-chip'));
    await waitFor(() => expect(screen.getByTestId('app-presentation-card')).toBeTruthy());
    const frame = screen.getByTitle('Support Triage Console preview') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toContain('path=shared%2Fapps%2Fsupport-triage-console%2Fpreview.html');
    expect(frame.getAttribute('src')).toContain('preview=1');
    expect(frame.className).toContain('h-[28rem]');
    fireEvent.click(screen.getByText('Collapse'));
    await waitFor(() => expect(screen.queryByTestId('app-presentation-card')).toBeNull());
  });
});
