// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import { Sidebar } from './Sidebar';

vi.mock('../sessions/api', () => ({
  sessionsApi: { list: vi.fn(async () => ({ sessions: [] })) },
}));

function renderSidebar() {
  render(
    <ThemeProvider>
      <Sidebar
        workspaceName="atrium"
        channels={[]}
        activeChannelId={null}
        unread={{}}
        me={{ id: 'u-1', handle: 'ada', displayName: 'Ada' }}
        wsStatus="open"
        queueSync={{ queuedCount: 0, syncStuck: false }}
        onSelect={vi.fn()}
        onSetMute={vi.fn()}
        onCreateChannel={vi.fn()}
        onStartDm={vi.fn()}
        onOpenSession={vi.fn()}
        sessionEventSeq={0}
        onLogout={vi.fn()}
      />
    </ThemeProvider>,
  );
}

function pointerMouseEvent(type: string, clientX: number): MouseEvent {
  const event = new MouseEvent(type, { button: 0, clientX, bubbles: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('Sidebar resize', () => {
  it('grows to the right, clamps, and persists on pointer up', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    renderSidebar();
    const handle = screen.getByTestId('sidebar-resize-handle') as HTMLElement;
    const nav = handle.parentElement as HTMLElement;
    handle.setPointerCapture = vi.fn();
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue({
      width: 224,
      height: 600,
      top: 0,
      right: 224,
      bottom: 600,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      handle.dispatchEvent(pointerMouseEvent('pointerdown', 224));
      handle.dispatchEvent(pointerMouseEvent('pointermove', 724));
    });

    expect(nav.style.getPropertyValue('--sidebar-w')).toBe('min(400px, 40vw)');
    expect(window.localStorage.getItem('atrium.sidebarWidth')).toBeNull();

    act(() => handle.dispatchEvent(pointerMouseEvent('pointerup', 724)));

    expect(window.localStorage.getItem('atrium.sidebarWidth')).toBe('400');
    expect(handle.getAttribute('aria-valuenow')).toBe('400');
  });

  it('clamps at the minimum and resets to the default on double click', () => {
    window.localStorage.setItem('atrium.sidebarWidth', '260');
    renderSidebar();
    const handle = screen.getByTestId('sidebar-resize-handle') as HTMLElement;
    const nav = handle.parentElement as HTMLElement;
    handle.setPointerCapture = vi.fn();
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue({
      width: 260,
      height: 600,
      top: 0,
      right: 260,
      bottom: 600,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      handle.dispatchEvent(pointerMouseEvent('pointerdown', 260));
      handle.dispatchEvent(pointerMouseEvent('pointerup', 0));
    });
    expect(window.localStorage.getItem('atrium.sidebarWidth')).toBe('180');

    act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));

    expect(window.localStorage.getItem('atrium.sidebarWidth')).toBeNull();
    expect(nav.style.getPropertyValue('--sidebar-w')).toBe('224px');
    expect(handle.getAttribute('aria-valuenow')).toBe('224');
  });
});
