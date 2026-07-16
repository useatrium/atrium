// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Session, SessionListItem } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionsApi } from '../sessions/api';
import { AgentsSurface } from './AgentsSurface';

vi.mock('../sessions/api', () => ({
  sessionsApi: { list: vi.fn() },
}));

const list = vi.mocked(sessionsApi.list);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 's-1',
    channelId: 'ch-1',
    channelName: 'engineering',
    title: 'Bump biome to 1.9',
    status: 'completed',
    harness: 'codex',
    spawnedBy: 'u-1',
    spawnerName: 'Ada Lovelace',
    costUsd: 0,
    createdAt: '2026-07-05T12:00:00.000Z',
    completedAt: '2026-07-05T12:00:42.000Z',
    archivedAt: null,
    pinned: false,
    needsAttention: false,
    attentionReason: null,
    resultText: null,
    ...overrides,
  };
}

function liveSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: 'Bump biome to 1.9',
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
    createdAt: '2026-07-05T12:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/s/s-1',
    ...overrides,
  };
}

describe('AgentsSurface', () => {
  it('uses terminal outcome grammar in the session row meta text', async () => {
    list.mockResolvedValue({ sessions: [session()] });

    render(<AgentsSurface liveSessions={{}} refreshKey={0} onOpenSession={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Done in 42s/)).toBeTruthy());
    expect(screen.getByText(/Done in 42s/).textContent).toContain('Done in 42s');
  });

  it('does not let an unknown live entity override a known REST outcome', async () => {
    list.mockResolvedValue({ sessions: [session()] });

    render(
      <AgentsSurface
        liveSessions={{ 's-1': liveSession({ status: 'unknown' as Session['status'] }) }}
        refreshKey={0}
        onOpenSession={() => {}}
      />,
    );

    const chip = await screen.findByTestId('glance-chip');
    expect(chip.textContent).toContain('Done');
    expect(chip.textContent).not.toContain('Status unavailable');
    expect(screen.getByText(/Done in 42s/)).toBeTruthy();
  });

  it('groups a live seat request under Needs you', async () => {
    list.mockResolvedValue({
      sessions: [
        session({
          status: 'running',
          completedAt: null,
          needsAttention: false,
        }),
      ],
    });

    render(
      <AgentsSurface
        liveSessions={{
          's-1': liveSession({
            pendingSeatRequests: [{ userId: 'u-2', displayName: 'Bea Chan' }],
          }),
        }}
        refreshKey={0}
        onOpenSession={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getAllByText('Needs you')).toHaveLength(2));
    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.getByTestId('glance-chip').textContent).toContain('Needs you');
  });

  it('keeps live attention fields while replacing an unknown status from REST', async () => {
    list.mockResolvedValue({
      sessions: [session({ status: 'running', completedAt: null })],
    });

    render(
      <AgentsSurface
        liveSessions={{
          's-1': liveSession({
            status: 'unknown' as Session['status'],
            pendingSeatRequests: [{ userId: 'u-2', displayName: 'Bea Chan' }],
          }),
        }}
        refreshKey={0}
        onOpenSession={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getAllByText('Needs you')).toHaveLength(2));
    expect(screen.getByTestId('glance-chip').textContent).toContain('seat request');
  });
});
