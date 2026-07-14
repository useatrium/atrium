// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../api';
import { ThemeProvider } from '../theme';
import { Sidebar } from './Sidebar';

const CHANNEL: Channel = {
  id: 'channel-1',
  workspaceId: 'workspace-1',
  name: 'general',
  createdAt: '2026-07-13T12:00:00.000Z',
  archivedAt: null,
  pinned: false,
  muted: false,
  kind: 'public',
};

function renderSidebar() {
  render(
    <ThemeProvider>
      <Sidebar
        workspaceName="atrium"
        channels={[CHANNEL]}
        activeChannelId={null}
        unread={{}}
        me={{ id: 'u-1', handle: 'ada', displayName: 'Ada' }}
        wsStatus="open"
        queueSync={{ queuedCount: 0, syncStuck: false }}
        onSelect={vi.fn()}
        onSetMute={vi.fn()}
        onSetArchived={vi.fn()}
        onSetPinned={vi.fn()}
        onCreateChannel={vi.fn()}
        onStartDm={vi.fn()}
        onLogout={vi.fn()}
      />
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('Sidebar channel actions', () => {
  it('leaves the native context menu untouched', () => {
    renderSidebar();
    const channelRow = screen.getByText('general').closest('li');
    expect(channelRow).not.toBeNull();

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(channelRow as HTMLElement, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Channel actions' })).toBeNull();
  });

  it('keeps Pin, Archive, and Mute reachable from the More button when inline actions are hidden', () => {
    renderSidebar();
    const moreButton = screen.getByRole('button', { name: 'More actions for #general' });
    expect(moreButton.getAttribute('aria-haspopup')).toBe('dialog');

    // The ⋯ must be a real focus stop — Pin/Archive used to vanish entirely at
    // narrow sidebar widths, leaving right-click as their only route.
    moreButton.focus();
    expect(document.activeElement).toBe(moreButton);

    // Stand in for the container-query widths that display:none the inline buttons.
    for (const name of ['Pin general', 'Archive general', 'Mute general']) {
      screen.getByRole('button', { name }).style.display = 'none';
    }

    fireEvent.click(moreButton);
    const menu = screen.getByRole('dialog', { name: 'Channel actions' });
    for (const name of ['Pin', 'Archive', 'Mute']) {
      const item = within(menu).getByRole('button', { name });
      expect(item).toBeTruthy();
      expect((item as HTMLButtonElement).disabled).toBe(false);
    }
  });
});
