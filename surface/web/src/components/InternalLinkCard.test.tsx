// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { memo } from 'react';
import type { Channel, Session } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionsContextProvider } from '../sessions/SessionsContext';
import { InternalLinkCard } from './InternalLinkCard';

const channel: Channel = {
  id: 'channel-1',
  workspaceId: 'workspace-1',
  name: 'engineering',
  createdAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
  pinned: false,
  kind: 'private',
  memberCount: 8,
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    channelId: channel.id,
    threadRootEventId: 434,
    title: 'Ship internal link cards',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'user-1',
    driverId: null,
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/c/channel-1/s/session-1',
    ...overrides,
  };
}

const linkRef = { kind: 'session', sessionId: 'session-1', channelId: 'channel-1' } as const;
const MemoizedInternalLinkCard = memo(InternalLinkCard);

afterEach(cleanup);

describe('InternalLinkCard', () => {
  it('re-renders its GlanceChip through context across a memoized boundary', () => {
    const requestSession = vi.fn();
    const running = session();
    const view = render(
      <SessionsContextProvider value={{ sessions: { [running.id]: running }, channels: [channel], requestSession }}>
        <MemoizedInternalLinkCard linkRef={linkRef} />
      </SessionsContextProvider>,
    );

    expect(screen.getByTestId('glance-chip').dataset.kind).toBe('working');
    expect(screen.getByText('Working', { exact: false })).toBeTruthy();

    const completed = session({ status: 'completed', completedAt: '2026-01-01T00:05:00.000Z' });
    view.rerender(
      <SessionsContextProvider value={{ sessions: { [completed.id]: completed }, channels: [channel], requestSession }}>
        <MemoizedInternalLinkCard linkRef={linkRef} />
      </SessionsContextProvider>,
    );

    expect(screen.getByTestId('glance-chip').dataset.kind).toBe('done');
    expect(screen.getByText('Done', { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ship internal link cards' }).getAttribute('href')).toBe(
      '/c/channel-1/s/session-1',
    );
    expect(screen.getByText('Codex agent')).toBeTruthy();
    // The fixture channel is private, so its ref carries a lock — never a "#".
    expect(screen.getByText('engineering')).toBeTruthy();
    expect(screen.queryByText('#engineering')).toBeNull();
  });

  it('names a DM by its partner rather than hash-prefixing it', () => {
    const dm: Channel = {
      id: 'dm-1',
      workspaceId: 'workspace-1',
      name: 'dm-raw-name',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
      pinned: false,
      kind: 'dm',
      members: [
        { id: 'me', handle: 'me', displayName: 'Me' },
        { id: 'them', handle: 'alice', displayName: 'Alice' },
      ],
    };

    render(
      <SessionsContextProvider value={{ sessions: {}, channels: [dm], requestSession: vi.fn() }}>
        <InternalLinkCard linkRef={{ kind: 'channel', channelId: dm.id, membersOpen: false }} meId="me" />
      </SessionsContextProvider>,
    );

    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.queryByText('#Alice')).toBeNull();
    expect(screen.queryByText('dm-raw-name')).toBeNull();
  });

  it('renders a channel affordance and the available private member count', () => {
    render(
      <SessionsContextProvider value={{ sessions: {}, channels: [channel], requestSession: vi.fn() }}>
        <InternalLinkCard linkRef={{ kind: 'channel', channelId: channel.id, membersOpen: true }} />
      </SessionsContextProvider>,
    );

    expect(screen.getByRole('link', { name: 'engineering' }).getAttribute('href')).toBe('/c/channel-1/members');
    expect(screen.getByText('8 members')).toBeTruthy();
    expect(document.querySelector('svg')).toBeTruthy();
  });
});
