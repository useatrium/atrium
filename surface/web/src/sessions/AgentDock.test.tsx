// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Channel } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_DOCK_OPEN_STORAGE_KEY, AGENT_DOCK_WIDTH_STORAGE_KEY } from '../storageKeys';
import { AgentDock, type AgentDockProps } from './AgentDock';
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
    meId: null,
    onFocusAgent: vi.fn(),
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

  it('uses the dock only to inspect agents, without a duplicate creation action', () => {
    render(<AgentDock {...props()} />);

    expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull();
    openDock();
    expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull();
  });

  it('suppresses the mobile dock layer while mobile navigation is open', () => {
    render(<AgentDock {...props({ mobileNavigationOpen: true })} />);

    const dock = screen.getByTestId('agent-dock');
    expect(dock.getAttribute('data-mobile-suppressed')).toBe('true');
    expect(dock.className).toContain('max-md:hidden');

    openDock();
    expect(screen.getByRole('button', { name: 'Close agent dock sheet' }).className).toContain('max-md:hidden');
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
    expect(dock.style.getPropertyValue('--agent-dock-w')).toBe('320px');
  });

  it('defaults to 320px when unsized but honors a stored width preference', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    window.localStorage.setItem(AGENT_DOCK_OPEN_STORAGE_KEY, 'true');

    const { unmount } = render(<AgentDock {...props()} />);
    // No stored size → the raised default, not the old 256px that truncated rows.
    expect((screen.getByTestId('agent-dock') as HTMLElement).style.getPropertyValue('--agent-dock-w')).toBe('320px');
    unmount();

    // A stored preference still wins over the default.
    window.localStorage.setItem(AGENT_DOCK_WIDTH_STORAGE_KEY, '288');
    render(<AgentDock {...props()} />);
    expect((screen.getByTestId('agent-dock') as HTMLElement).style.getPropertyValue('--agent-dock-w')).toBe(
      'min(288px, 40vw)',
    );
  });

  it('strictly filters needs-you and channel groups to the selected workstream', () => {
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

    expect(screen.queryByText('Answer deployment question')).toBeNull();
    expect(screen.getByText('Launch agent')).toBeTruthy();
    expect(screen.queryByText('Engineering agent')).toBeNull();
    expect(screen.getByTestId('agent-dock-total').textContent).toBe('1');
  });

  it('explains empty strict filters without implying the workspace has no agents', () => {
    const { unmount } = render(
      <AgentDock
        {...props({
          sessions: { launch: session({ channelId: 'channel-2', title: 'Launch agent' }) },
          filterChannelId: 'channel-1',
        })}
      />,
    );

    expect(screen.getByText('No agents in this workstream')).toBeTruthy();

    unmount();
    window.localStorage.clear();
    render(
      <AgentDock
        {...props({
          sessions: {
            launch: session({ channelId: 'channel-2', driverId: 'user-2', title: 'Launch agent' }),
          },
          meId: 'user-1',
        })}
      />,
    );
    openDock();
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
    expect(screen.getByText('No agents assigned to you')).toBeTruthy();
  });

  it('archives every listed terminal History session after confirmation', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Archive all…' }));

    await waitFor(() => expect(onSetArchived).toHaveBeenCalledTimes(2));
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

  it('provides the responsive sheet frame and a top-anchored resting opener', () => {
    render(<AgentDock {...props()} />);
    const opener = screen.getByRole('button', { name: /Open agent dock/ });
    expect(opener.className).toContain('md:flex-none');
    expect(opener.className).not.toContain('md:flex-1');
    openDock();

    expect(screen.getByTestId('agent-dock').className).toContain('h-[60dvh]');
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
});
