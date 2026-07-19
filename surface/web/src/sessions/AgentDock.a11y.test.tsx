// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_DOCK_OPEN_STORAGE_KEY, AGENT_DOCK_WIDTH_STORAGE_KEY } from '../storageKeys';
import { AgentDock, type AgentDockProps } from './AgentDock';
import type { Session } from './types';

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
    createdAt: '2026-07-18T10:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/s/session-1',
    ...overrides,
  };
}

function renderDock(overrides: Partial<AgentDockProps> = {}) {
  const props: AgentDockProps = {
    sessions: {},
    channels: [],
    activeChannelId: null,
    focusedSessionId: null,
    immersed: false,
    meId: 'user-1',
    onFocusAgent: vi.fn(),
    onToggleImmersed: vi.fn(),
    onNewAgent: vi.fn(),
    ...overrides,
  };
  return render(<AgentDock {...props} />);
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2000 });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AgentDock resize handle keyboard operation', () => {
  it('grows toward the drag edge, jumps to bounds, and resets with Enter', () => {
    window.localStorage.setItem(AGENT_DOCK_OPEN_STORAGE_KEY, 'true');
    renderDock();
    const handle = screen.getByTestId('agent-dock-resize-handle') as HTMLElement;
    expect(handle.getAttribute('aria-valuenow')).toBe('256'); // fallback default

    // The dock's handle grows to the left → ArrowLeft enlarges, ArrowRight shrinks.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('272');
    expect(window.localStorage.getItem(AGENT_DOCK_WIDTH_STORAGE_KEY)).toBe('272');

    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(handle.getAttribute('aria-valuenow')).toBe('336');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('320');

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle.getAttribute('aria-valuenow')).toBe('224'); // min

    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle.getAttribute('aria-valuenow')).toBe('800'); // 40vw of 2000

    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(handle.getAttribute('aria-valuenow')).toBe('256'); // reset to default
    expect(window.localStorage.getItem(AGENT_DOCK_WIDTH_STORAGE_KEY)).toBeNull();
  });
});

function stubMatchMedia(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query === '(min-width: 768px)' ? wide : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('AgentDock focus hand-off', () => {
  it('at md+ moves focus into the filter field on open and back to the spine button on collapse', () => {
    stubMatchMedia(true);
    renderDock();
    const openButton = screen.getByRole('button', { name: /Open agent dock/ });
    // Resting: no filter field yet, and opening must not have stolen focus on mount.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(document.activeElement).not.toBe(openButton);

    fireEvent.click(openButton);
    const filter = screen.getByRole('searchbox', { name: 'Filter agents' });
    expect(document.activeElement).toBe(filter);

    const collapse = screen.getByRole('button', { name: 'Collapse agent dock' });
    fireEvent.click(collapse);
    // Back to resting — focus returns to the (remounted) spine open button.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Open agent dock/ }));
  });

  it('below md focuses the heading, not the filter input (no software keyboard on the touch sheet)', () => {
    stubMatchMedia(false);
    renderDock();
    fireEvent.click(screen.getByRole('button', { name: /Open agent dock/ }));

    const heading = screen.getByRole('heading', { name: 'Agents' });
    expect(document.activeElement).toBe(heading);
    expect(document.activeElement).not.toBe(screen.getByRole('searchbox', { name: 'Filter agents' }));

    // Collapse still returns focus to the spine button regardless of width.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse agent dock' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Open agent dock/ }));
  });
});

describe('AgentDock heading hygiene', () => {
  it('renders the dock title as an h2, not a second h1', () => {
    window.localStorage.setItem(AGENT_DOCK_OPEN_STORAGE_KEY, 'true');
    renderDock();
    const title = screen.getByText('Agents');
    expect(title.tagName).toBe('H2');
    expect(document.querySelector('h1')).toBeNull();
  });
});

describe('AgentDock History clear control', () => {
  it('keeps the Clear button out of the <summary> disclosure control', () => {
    window.localStorage.setItem(AGENT_DOCK_OPEN_STORAGE_KEY, 'true');
    renderDock({
      sessions: { 'session-1': session({ status: 'completed', completedAt: '2026-07-18T11:00:00.000Z' }) },
      onSetArchived: vi.fn(),
    });
    const history = screen.getByTestId('agent-dock-history');
    const summary = history.querySelector('summary') as HTMLElement;
    const clear = screen.getByRole('button', { name: 'Clear' });
    expect(clear).toBeTruthy();
    expect(summary.contains(clear)).toBe(false);
  });
});
