// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { SessionListItem } from '@atrium/surface-client';
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

describe('AgentsSurface', () => {
  it('uses terminal outcome grammar in the session row meta text', async () => {
    list.mockResolvedValue({ sessions: [session()] });

    render(<AgentsSurface liveSessions={{}} refreshKey={0} onOpenSession={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Done in 42s/)).toBeTruthy());
    expect(screen.getByText(/Done in 42s/).textContent).toContain('Done in 42s');
  });
});
