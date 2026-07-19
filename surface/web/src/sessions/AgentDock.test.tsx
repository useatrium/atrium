// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Channel } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_DOCK_OPEN_STORAGE_KEY, AGENT_DOCK_WIDTH_STORAGE_KEY } from '../storageKeys';
import { AgentDock, type AgentDockProps, sidebarImmersionClassName } from './AgentDock';
import type { Session } from './types';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

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
    meId: null,
    onFocusAgent: vi.fn(),
    onToggleImmersed: vi.fn(),
    onNewAgent: vi.fn(),
    ...overrides,
  };
}

function openDock() {
  fireEvent.click(screen.getByRole('button', { name: /Open agent dock/ }));
}

function pointerMouseEvent(type: string, clientX: number): MouseEvent {
  const event = new MouseEvent(type, { button: 0, clientX, bubbles: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
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

  it('clears the workstream filter from the chip', () => {
    const onClearFilter = vi.fn();
    render(
      <AgentDock
        {...props({
          sessions: {
            launch: session({ id: 'launch', channelId: 'channel-2', title: 'Launch agent' }),
          },
          filterChannelId: 'channel-2',
          onClearFilter,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear workstream filter' }));

    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });

  it('persists and clamps the open dock width, then resets on double click', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    window.localStorage.setItem(AGENT_DOCK_OPEN_STORAGE_KEY, 'true');
    render(<AgentDock {...props()} />);
    const dock = screen.getByTestId('agent-dock') as HTMLElement;
    const handle = screen.getByTestId('agent-dock-resize-handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue({
      width: 256,
      height: 600,
      top: 0,
      right: 1000,
      bottom: 600,
      left: 744,
      x: 744,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      handle.dispatchEvent(pointerMouseEvent('pointerdown', 744));
      handle.dispatchEvent(pointerMouseEvent('pointermove', 0));
    });
    expect(dock.style.getPropertyValue('--agent-dock-w')).toBe('min(400px, 40vw)');
    expect(window.localStorage.getItem(AGENT_DOCK_WIDTH_STORAGE_KEY)).toBeNull();

    act(() => handle.dispatchEvent(pointerMouseEvent('pointerup', 600)));
    expect(window.localStorage.getItem(AGENT_DOCK_WIDTH_STORAGE_KEY)).toBe('400');
    expect(handle.getAttribute('aria-valuenow')).toBe('400');

    act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(window.localStorage.getItem(AGENT_DOCK_WIDTH_STORAGE_KEY)).toBeNull();
    expect(dock.style.getPropertyValue('--agent-dock-w')).toBe('256px');
  });

  it('keeps global needs-you visible and collapses non-matching channel groups while filtered', () => {
    render(
      <AgentDock
        {...props({
          sessions: {
            attention: session({
              id: 'attention',
              title: 'Answer deployment question',
              pendingQuestion: {
                questionId: 'question-1',
                questions: [],
                askedAt: new Date().toISOString(),
              },
            }),
            engineering: session({ id: 'engineering', title: 'Engineering agent' }),
            launch: session({ id: 'launch', channelId: 'channel-2', title: 'Launch agent' }),
          },
          filterChannelId: 'channel-2',
        })}
      />,
    );

    expect(screen.getByText('Answer deployment question')).toBeTruthy();
    expect(screen.getByText('Launch agent')).toBeTruthy();
    const softened = screen.getByTestId('agent-dock-softened-group');
    expect(within(softened).getByText('engineering')).toBeTruthy();
    expect(screen.queryByText('Engineering agent')).toBeNull();

    fireEvent.click(within(softened).getByText('engineering'));
    expect(screen.getByText('Engineering agent')).toBeTruthy();
  });

  it('clears every listed terminal History session after confirmation', () => {
    const onSetArchived = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <AgentDock
        {...props({
          sessions: {
            completed: session({
              id: 'completed',
              title: 'Completed agent',
              status: 'completed',
              completedAt: new Date().toISOString(),
            }),
            cancelled: session({
              id: 'cancelled',
              title: 'Cancelled agent',
              status: 'cancelled',
              completedAt: new Date().toISOString(),
            }),
          },
          onSetArchived,
        })}
      />,
    );
    openDock();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onSetArchived).toHaveBeenCalledTimes(2);
    expect(onSetArchived).toHaveBeenCalledWith('completed', true, null);
    expect(onSetArchived).toHaveBeenCalledWith('cancelled', true, null);
  });

  it('keeps terminal sessions older than seven days behind Show older', () => {
    render(
      <AgentDock
        {...props({
          sessions: {
            recent: session({
              id: 'recent',
              title: 'Recent result',
              status: 'completed',
              completedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1_000).toISOString(),
            }),
            older: session({
              id: 'older',
              title: 'Older result',
              status: 'completed',
              completedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
            }),
          },
        })}
      />,
    );
    openDock();

    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('Recent result')).toBeTruthy();
    expect(screen.queryByText('Older result')).toBeNull();

    fireEvent.click(screen.getByText('Show older'));
    expect(screen.getByText('Older result')).toBeTruthy();
  });

  it('exposes status text for each resting-spine dot', () => {
    render(<AgentDock {...props({ sessions: { live: session({ id: 'live', title: 'Ship mobile dock' }) } })} />);

    const list = screen.getByRole('list', { name: 'Live agents', hidden: true });
    expect(within(list).getByRole('listitem', { name: /Ship mobile dock:/, hidden: true })).toBeTruthy();
  });

  it('provides the responsive sheet frame and sidebar immersion seam', () => {
    render(<AgentDock {...props()} />);
    openDock();

    expect(screen.getByTestId('agent-dock').className).toContain('h-[60dvh]');
    expect(sidebarImmersionClassName(true)).toContain('md:w-0');
    expect(sidebarImmersionClassName(false)).toBe('contents');
  });

  it('clears a non-empty filter query on Escape before dismissing the dock', () => {
    render(<AgentDock {...props({ sessions: { one: session({ id: 'one', title: 'Alpha agent' }) } })} />);
    openDock();

    const search = screen.getByRole('searchbox', { name: 'Filter agents' }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'alpha' } });
    expect(search.value).toBe('alpha');

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search.value).toBe('');
    expect(screen.getByTestId('agent-dock').getAttribute('data-state')).toBe('open');

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.getByTestId('agent-dock').getAttribute('data-state')).toBe('resting');
  });

  it('collapses the open dock on Escape', () => {
    render(<AgentDock {...props()} />);
    openDock();
    expect(screen.getByTestId('agent-dock').getAttribute('data-state')).toBe('open');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByTestId('agent-dock').getAttribute('data-state')).toBe('resting');
  });

  it('exits immersion on Escape', () => {
    const onToggleImmersed = vi.fn();
    render(<AgentDock {...props({ immersed: true, onToggleImmersed })} />);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onToggleImmersed).toHaveBeenCalledTimes(1);
  });
});
