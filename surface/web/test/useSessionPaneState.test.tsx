// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppAction,
  Channel,
  Session,
  SessionWire,
  UserRef,
} from '@atrium/surface-client';
import { useSessionPaneState, sessionSpectatorCounts } from '../src/useSessionPaneState';

const createdAt = '2026-06-28T17:00:00.000Z';
const user: UserRef = { id: 'u-1', handle: 'alice', displayName: 'Alice' };

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    workspaceId: 'ws-1',
    name: 'general',
    createdAt,
    kind: 'public',
    archivedAt: null,
    pinned: false,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: 'Fix the build',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-1',
    driverId: 'u-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt,
    completedAt: null,
    lastEventId: 1,
    permalink: '/s/s-1',
    archivedAt: null,
    pinned: false,
    ...overrides,
  };
}

function wire(overrides: Partial<SessionWire> = {}): SessionWire {
  return {
    id: 's-2',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: 'Review the PR',
    status: 'queued',
    harness: 'codex',
    spawnedBy: 'u-1',
    driverId: 'u-1',
    costUsd: 0,
    resultText: null,
    createdAt,
    completedAt: null,
    lastEventId: 2,
    permalink: '/s/s-2',
    archivedAt: null,
    pinned: false,
    ...overrides,
  };
}

function renderPaneState({
  activeChannel = channel(),
  client = { get: vi.fn(async () => ({ session: wire() })) },
  isMobileViewport = false,
  openSessionId = 's-1',
  presence = {},
  sessions = { 's-1': session() },
}: Partial<Parameters<typeof useSessionPaneState>[0]> = {}) {
  const dispatch = vi.fn<(action: AppAction) => void>();
  const view = renderHook((props: Parameters<typeof useSessionPaneState>[0]) =>
    useSessionPaneState(props),
  {
    initialProps: {
      activeChannel,
      client,
      dispatch,
      isMobileViewport,
      openSessionId,
      presence,
      sessions,
    },
  });
  return { ...view, client, dispatch };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('sessionSpectatorCounts', () => {
  it('counts only session presence keys', () => {
    expect(
      sessionSpectatorCounts({
        'session:s-1': [user],
        'session:s-2': [user, { ...user, id: 'u-2' }],
        'ch-1': [user],
      }),
    ).toEqual({ 's-1': 1, 's-2': 2 });
  });
});

describe('useSessionPaneState', () => {
  it('derives pane session, watchers, rail visibility, and layout', () => {
    const { result } = renderPaneState({
      presence: { 'session:s-1': [user] },
    });

    expect(result.current.view).toBe('split');
    expect(result.current.sessionPaneLayout).toBe('split');
    expect(result.current.paneSession?.id).toBe('s-1');
    expect(result.current.paneWatchers).toEqual([user]);
    expect(result.current.hasChannelSessions).toBe(true);
    expect(result.current.spectators).toEqual({ 's-1': 1 });
  });

  it('uses focus layout on mobile even when the desktop view is split', () => {
    const { result } = renderPaneState({ isMobileViewport: true });

    expect(result.current.view).toBe('split');
    expect(result.current.sessionPaneLayout).toBe('focus');
  });

  it('opens confirmed sessions as a peek and upserts the fetched session', async () => {
    const fetched = wire({ id: 's-2', title: 'Fetched session' });
    const client = { get: vi.fn(async () => ({ session: fetched })) };
    const { result, dispatch } = renderPaneState({ client, openSessionId: null, sessions: {} });

    act(() => result.current.openSession('s-2'));

    expect(dispatch).toHaveBeenCalledWith({ type: 'open-session', sessionId: 's-2' });
    expect(client.get).toHaveBeenCalledWith('s-2');
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session-upsert',
          session: expect.objectContaining({ id: 's-2', title: 'Fetched session' }),
        }),
      ),
    );
  });

  it('ignores pending optimistic session ids', () => {
    const { result, dispatch, client } = renderPaneState({ openSessionId: null, sessions: {} });

    act(() => result.current.openSession('pending:local'));

    expect(dispatch).not.toHaveBeenCalled();
    expect(client.get).not.toHaveBeenCalled();
  });

  it('dispatches a recoverable failed state when open fetch fails', async () => {
    const client = {
      get: vi.fn(async () => {
        throw new Error('missing');
      }),
    };
    const { result, dispatch } = renderPaneState({ client, openSessionId: null, sessions: {} });

    act(() => result.current.openSession('s-missing'));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({
        type: 'session-load-failed',
        sessionId: 's-missing',
      }),
    );
  });

  it('switches views and resets focus after the pane closes', async () => {
    const { result, rerender, dispatch } = renderPaneState();

    act(() => result.current.setView('focus'));
    expect(result.current.view).toBe('focus');

    act(() => result.current.setView('channel'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'close-session' });

    rerender({
      activeChannel: channel(),
      client: { get: vi.fn(async () => ({ session: wire() })) },
      dispatch,
      isMobileViewport: false,
      openSessionId: null,
      presence: {},
      sessions: {},
    });

    await waitFor(() => expect(result.current.view).toBe('channel'));

    rerender({
      activeChannel: channel(),
      client: { get: vi.fn(async () => ({ session: wire() })) },
      dispatch,
      isMobileViewport: false,
      openSessionId: 's-1',
      presence: {},
      sessions: { 's-1': session() },
    });
    expect(result.current.view).toBe('split');
  });
});
