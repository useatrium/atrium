// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Channel } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDock, type AgentDockProps } from './AgentDock';
import type { Session } from './types';

afterEach(cleanup);

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    channelId: 'channel-1',
    threadRootEventId: null,
    title: 'Agent session',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'user-1',
    driverId: 'user-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/s/session-1',
    ...overrides,
  };
}

const channels = [
  { id: 'channel-1', name: 'engineering' },
  { id: 'channel-2', name: 'launch' },
] as Channel[];

function props(overrides: Partial<AgentDockProps> = {}): AgentDockProps {
  return {
    sessions: {},
    channels,
    activeChannelId: 'channel-1',
    focusedSessionId: null,
    immersed: false,
    onFocusAgent: vi.fn(),
    onToggleImmersed: vi.fn(),
    onNewAgent: vi.fn(),
    ...overrides,
  };
}

function openDock() {
  fireEvent.click(screen.getByRole('button', { name: /Open agent dock/ }));
}

describe('AgentDock', () => {
  it('pins needs-you first, then groups live agents by channel', () => {
    render(
      <AgentDock
        {...props({
          sessions: {
            launch: session({ id: 'launch', channelId: 'channel-2', title: 'Prepare launch notes' }),
            engineering: session({ id: 'engineering', title: 'Run integration tests' }),
            attention: session({
              id: 'attention',
              title: 'Choose migration strategy',
              pendingQuestion: {
                questionId: 'question-1',
                questions: [{ id: 'prompt-1', header: 'Migration', question: 'Which migration strategy?' }],
                askedAt: new Date(Date.now() - 120_000).toISOString(),
              },
            }),
          },
        })}
      />,
    );

    openDock();

    const groups = screen.getAllByTestId('agent-dock-group');
    expect(groups.map((group) => group.getAttribute('data-kind'))).toEqual(['needs', 'channel', 'channel']);
    expect(within(groups[0]!).getByText('Choose migration strategy')).toBeTruthy();
    expect(within(groups[1]!).getByRole('heading', { name: /engineering/ })).toBeTruthy();
    expect(within(groups[1]!).getByText('Run integration tests')).toBeTruthy();
    expect(within(groups[2]!).getByRole('heading', { name: /launch/ })).toBeTruthy();
    expect(within(groups[2]!).getByText('Prepare launch notes')).toBeTruthy();
  });

  it('focuses an agent when its row is clicked', () => {
    const onFocusAgent = vi.fn();
    render(
      <AgentDock
        {...props({
          sessions: { one: session({ id: 'one', title: 'Investigate flaky test' }) },
          onFocusAgent,
        })}
      />,
    );
    openDock();

    fireEvent.click(screen.getByRole('button', { name: 'Focus agent Investigate flaky test' }));

    expect(onFocusAgent).toHaveBeenCalledWith('one');
  });

  it('shows the needs-you count on the resting spine', () => {
    render(
      <AgentDock
        {...props({
          sessions: {
            question: session({
              id: 'question',
              pendingQuestion: {
                questionId: 'question-1',
                questions: [],
                askedAt: new Date().toISOString(),
              },
            }),
            failed: session({ id: 'failed', status: 'failed', completedAt: new Date().toISOString() }),
          },
        })}
      />,
    );

    expect(screen.getByTestId('agent-dock-needs-badge').textContent).toBe('2');
    expect(screen.getByTestId('agent-dock').getAttribute('data-state')).toBe('resting');
  });

  it('renders the immersed dock instead of the resting spine', () => {
    const view = render(<AgentDock {...props()} />);
    expect(screen.getByTestId('agent-dock').getAttribute('data-state')).toBe('resting');
    expect(screen.queryByRole('searchbox', { name: 'Filter agents' })).toBeNull();

    view.rerender(<AgentDock {...props({ immersed: true })} />);

    expect(screen.getByTestId('agent-dock').getAttribute('data-state')).toBe('immersed');
    expect(screen.getByRole('searchbox', { name: 'Filter agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Exit immersed agent dock' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open agent dock/ })).toBeNull();
  });

  it('filters the dock to the requested channel', () => {
    render(
      <AgentDock
        {...props({
          sessions: {
            engineering: session({ id: 'engineering', title: 'Engineering agent' }),
            launch: session({ id: 'launch', channelId: 'channel-2', title: 'Launch agent' }),
          },
          filterChannelId: 'channel-2',
        })}
      />,
    );

    expect(screen.getByText('Launch agent')).toBeTruthy();
    expect(screen.queryByText('Engineering agent')).toBeNull();
    expect(screen.getByText('Workstream: #launch')).toBeTruthy();
  });
});
