// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { UserRef } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelAgentPresence } from './ChannelAgentPresence';
import type { Session } from './types';

const presentUsers: UserRef[] = [
  { id: 'u-1', handle: 'ada', displayName: 'Ada' },
  { id: 'u-2', handle: 'grace', displayName: 'Grace' },
];

function session(id: string, status: Session['status'], channelId = 'ch-1'): Session {
  return {
    id,
    workspaceId: 'ws-1',
    channelId,
    threadRootEventId: 1,
    title: `Agent ${id}`,
    status,
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
    createdAt: '2026-07-18T12:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 0,
    permalink: `/s/${id}`,
  };
}

afterEach(cleanup);

describe('ChannelAgentPresence', () => {
  it('shows the present people count and the live agents in this channel', () => {
    const sessions = {
      running: session('running', 'running'),
      queued: session('queued', 'queued'),
      spawning: session('spawning', 'spawning'),
      otherChannel: session('other-channel', 'running', 'ch-2'),
      done: session('done', 'completed'),
      failed: session('failed', 'failed'),
    };

    render(
      <ChannelAgentPresence
        channelId="ch-1"
        sessions={sessions}
        presentUsers={presentUsers}
        now={Date.now()}
        onOpenDock={vi.fn()}
      />,
    );

    expect(screen.getByText('2 people')).toBeTruthy();
    expect(screen.getByRole('button', { name: /3 agents here/ })).toBeTruthy();
    expect(screen.queryByText(/done|failed/i)).toBeNull();
  });

  it('hides the agent action when no live agents are in this channel', () => {
    render(
      <ChannelAgentPresence
        channelId="ch-1"
        sessions={{ done: session('done', 'completed'), failed: session('failed', 'failed') }}
        presentUsers={presentUsers}
        now={Date.now()}
        onOpenDock={vi.fn()}
      />,
    );

    expect(screen.getByText('2 people')).toBeTruthy();
    expect(screen.queryByText(/agents here/)).toBeNull();
  });

  it('opens the dock filtered to the channel from the agent action', () => {
    const onOpenDock = vi.fn();
    render(
      <ChannelAgentPresence
        channelId="ch-1"
        sessions={{ running: session('running', 'running') }}
        presentUsers={presentUsers}
        now={Date.now()}
        onOpenDock={onOpenDock}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /1 agents here/ }));

    expect(onOpenDock).toHaveBeenCalledOnce();
    expect(onOpenDock).toHaveBeenCalledWith('ch-1');
  });
});
