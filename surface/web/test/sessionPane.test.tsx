// @vitest-environment jsdom
// (b) The pane folds the B_tooltest fixture into one Bash tool card whose
// result contains atrium-roundtrip-ok, with a completed status chip.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import rawB from '../../../packages/centaur-client/test/fixtures/B_tooltest.json';
import { appReducer, initialAppState, type AppState } from '../src/appState';
import { SessionPane } from '../src/sessions/SessionPane';
import type { Session } from '../src/sessions/types';
import type { UserRef, WireEvent } from '../src/state';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

const B = rawB as unknown as CentaurEventFrame[];

const me = { id: 'u-me', handle: 'me', displayName: 'Me' };
const bob = { id: 'u-bob', handle: 'bob', displayName: 'Bob' };
const alice = { id: 'u-alice', handle: 'alice', displayName: 'Alice' };

function bSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-b',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: 'probe the toolchain',
    status: 'running',
    harness: 'claude-code',
    spawnedBy: me.id,
    spawnerName: me.displayName,
    driverId: null,
    pendingSeatRequests: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    lastEventId: 0,
    permalink: '/s/s-b',
    ...overrides,
  };
}

beforeEach(() => {
  FakeEventSource.reset();
  installFakeEventSource();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPaneWithB() {
  render(<SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} />);
  const es = FakeEventSource.last();
  expect(es.url).toBe('/api/sessions/s-b/stream?after_event_id=0');
  await act(async () => {
    es.open();
    es.emitAll(B);
    await new Promise((r) => setTimeout(r, 60)); // let the rAF batch flush
  });
  return es;
}

describe('session pane folds the B_tooltest stream', () => {
  it('renders one Bash tool card with the roundtrip result, completed status', async () => {
    await renderPaneWithB();

    // exactly one tool card, named Bash
    const cards = screen.getAllByTestId('tool-card');
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(within(card).getByText('Bash')).toBeTruthy();

    // completed tool calls auto-collapse: command preview, no result yet
    expect(within(card).getByText(/echo atrium-roundtrip-ok/)).toBeTruthy();
    expect(within(card).queryByText(/aarch64/)).toBeNull();

    // expand → full result content
    fireEvent.click(within(card).getByRole('button'));
    const result = within(card).getByText(/aarch64/);
    expect(result.textContent).toContain('atrium-roundtrip-ok');
    expect(result.textContent).toContain('/home/agent/workspace');

    // status chip reached completed (from the terminal execution_state)
    expect(screen.getByText('completed')).toBeTruthy();

    // pinned summary block carries the terminal result_text
    const summary = screen.getByTestId('session-result');
    expect(within(summary).getByText(/TOOLCHAIN_OK: atrium-roundtrip-ok/)).toBeTruthy();
  });

  it('reconnects from the last folded event id on stream error', async () => {
    const es = await renderPaneWithB();
    expect(FakeEventSource.instances).toHaveLength(1);
    // terminal state reached → an error must NOT trigger a reconnect loop
    await act(async () => {
      es.error();
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('resumes with after_event_id=<last seen> when erroring mid-stream', async () => {
    render(<SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} />);
    const es = FakeEventSource.last();
    const firstHalf = B.slice(0, 8); // still running — no terminal state yet
    await act(async () => {
      es.open();
      es.emitAll(firstHalf);
      await new Promise((r) => setTimeout(r, 60));
    });
    const lastSeen = Math.max(...firstHalf.map((f) => f.event_id));
    await act(async () => {
      es.error();
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last().url).toBe(
      `/api/sessions/s-b/stream?after_event_id=${lastSeen}`,
    );
    expect(es.closed).toBe(true);
  });

});

// ---- driver seat (Phase 3) --------------------------------------------------

function seatWire(
  id: number,
  type: string,
  payload: Record<string, unknown>,
  author: UserRef,
): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    type,
    actorId: author.id,
    payload,
    createdAt: new Date(id * 1000).toISOString(),
    author,
  };
}

/** App state with session s-b spawned by me — driver defaults to the spawner. */
function spawnedState(): AppState {
  let s = appReducer(initialAppState, {
    type: 'history-loaded',
    channelId: 'ch-1',
    events: [],
    hasMore: false,
  });
  s = appReducer(s, {
    type: 'server-event',
    event: seatWire(
      101,
      'session.spawned',
      { sessionId: 's-b', title: 'probe the toolchain', harness: 'claude-code', by: me.id },
      me,
    ),
  });
  return s;
}

function paneFor(s: AppState, asUser: UserRef = me, watchers: UserRef[] = []) {
  const session = s.sessions['s-b'];
  if (!session) throw new Error('session entity missing');
  return <SessionPane session={session} me={asUser} watchers={watchers} onClose={() => {}} />;
}

function stub202() {
  const fetchMock = vi.fn(
    async (..._args: Parameters<typeof fetch>) => new Response('{}', { status: 202 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('driver seat', () => {
  it('(a) seat_changed flips composer enablement and header driver live', () => {
    let s = spawnedState();
    const { rerender } = render(paneFor(s));

    // I spawned it → I hold the seat: enabled composer, "you have the seat".
    const boxBefore = screen.getByPlaceholderText(/you have the seat/i);
    expect((boxBefore as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByTestId('driver-chip').textContent).toBe('driver: Me');

    // Bob takes the seat — entity folds the WS event, no refetch.
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(
        102,
        'session.seat_changed',
        { sessionId: 's-b', from: me.id, to: bob.id, reason: 'taken' },
        bob,
      ),
    });
    rerender(paneFor(s));

    expect(screen.getByTestId('driver-chip').textContent).toBe('driver: Bob');
    const boxAfter = screen.getByPlaceholderText(/spectating — Bob has the seat/);
    expect((boxAfter as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('(b) seat_requested shows the grant banner to the driver only; grant posts the right body', async () => {
    const fetchMock = stub202();
    let s = spawnedState();
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(102, 'session.seat_requested', { sessionId: 's-b', by: bob.id }, bob),
    });
    expect(s.sessions['s-b']!.pendingSeatRequests).toEqual([
      { userId: bob.id, displayName: 'Bob' },
    ]);

    // A non-driver spectator never sees the banner.
    const spectator = { id: 'u-carol', handle: 'carol', displayName: 'Carol' };
    const first = render(paneFor(s, spectator));
    expect(screen.queryByTestId('seat-request-banner')).toBeNull();
    first.unmount();

    // The driver does, and Grant posts {userId} to seat/grant.
    render(paneFor(s, me));
    const banner = screen.getByTestId('seat-request-banner');
    expect(banner.textContent).toContain('Bob requests the seat');
    fireEvent.click(within(banner).getByText('Grant'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/sessions/s-b/seat/grant');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ userId: bob.id });

    // Ignore dismisses locally.
    fireEvent.click(within(banner).getByText('Ignore'));
    expect(screen.queryByTestId('seat-request-banner')).toBeNull();
  });

  it('(c) non-driver sees Request seat while the driver watches, and it posts seat/request', async () => {
    const fetchMock = stub202();
    const session = bSession({
      spawnedBy: alice.id,
      spawnerName: alice.displayName,
      driverId: alice.id,
      driverName: alice.displayName,
    });
    render(<SessionPane session={session} me={me} watchers={[alice, me]} onClose={() => {}} />);

    // Pure spectator: no cancel, composer disabled.
    expect(screen.queryByText('Cancel')).toBeNull();
    expect((screen.getByPlaceholderText(/spectating/) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByText('Take seat')).toBeNull();

    fireEvent.click(screen.getByText('Request seat'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/sessions/s-b/seat/request');
    expect(screen.getByTestId('seat-footer').textContent).toContain(
      'requested — waiting for Alice',
    );
  });

  it('(c) shows Take seat when the driver is absent; 409 falls back to a request', async () => {
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) =>
      String(args[0]).endsWith('/seat/take')
        ? new Response(JSON.stringify({ error: 'seat_held' }), { status: 409 })
        : new Response('{}', { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const session = bSession({
      spawnedBy: alice.id,
      spawnerName: alice.displayName,
      driverId: alice.id,
      driverName: alice.displayName,
    });
    render(<SessionPane session={session} me={me} watchers={[me]} onClose={() => {}} />);

    expect(screen.queryByText('Request seat')).toBeNull();
    fireEvent.click(screen.getByText('Take seat'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/sessions/s-b/seat/take',
      '/api/sessions/s-b/seat/request',
    ]);
    const footer = screen.getByTestId('seat-footer');
    expect(footer.textContent).toContain('seat held');
    expect(footer.textContent).toContain('requested — waiting for Alice');
  });

  it('(c) a successful take posts only seat/take', async () => {
    const fetchMock = stub202();
    const session = bSession({
      spawnedBy: alice.id,
      spawnerName: alice.displayName,
      driverId: alice.id,
      driverName: alice.displayName,
    });
    render(<SessionPane session={session} me={me} watchers={[]} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Take seat'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/sessions/s-b/seat/take');
  });

  it('(d) renders a compact audit line from seat_changed', () => {
    let s = spawnedState();
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(102, 'session.seat_requested', { sessionId: 's-b', by: bob.id }, bob),
    });
    // Granted: the actor is the old driver (me); Bob's name comes from his request.
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(
        103,
        'session.seat_changed',
        { sessionId: 's-b', from: me.id, to: bob.id, reason: 'granted' },
        me,
      ),
    });
    render(paneFor(s, me));

    const line = screen.getByTestId('seat-audit-line');
    expect(line.textContent).toContain('Me granted the seat to Bob');
    expect(line.textContent).toMatch(/\d{2}:\d{2}/);
    // The grant also cleared Bob's pending request.
    expect(s.sessions['s-b']!.pendingSeatRequests).toEqual([]);
    expect(screen.queryByTestId('seat-request-banner')).toBeNull();
  });
});
