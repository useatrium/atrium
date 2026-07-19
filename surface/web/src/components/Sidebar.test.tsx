// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Channel } from '../api';
import type { QueueSyncState, UnreadLevel, UserRef } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

afterEach(cleanup);

const me: UserRef = { id: 'user-1', handle: 'me', displayName: 'Me' } as UserRef;

function channel(id: string, name: string, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    name,
    kind: 'public',
    muted: false,
    pinned: false,
    archivedAt: null,
    ...overrides,
  } as Channel;
}

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    workspaceName: 'Acme',
    channels: [channel('c1', 'alpha'), channel('c2', 'bravo'), channel('c3', 'charlie')],
    activeChannelId: 'c1',
    unread: {} as Record<string, UnreadLevel>,
    me,
    wsStatus: 'open' as const,
    queueSync: { queuedCount: 0, syncStuck: false } as QueueSyncState,
    onSelect: vi.fn(),
    onSetMute: vi.fn(),
    onCreateChannel: vi.fn().mockResolvedValue(undefined),
    onStartDm: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
  return { ...render(<Sidebar {...props} />), props };
}

// The row button is the one wrapping the channel label; action buttons carry an
// aria-label, the row button does not.
const rowButton = (label: string) => screen.getByText(label).closest('button') as HTMLButtonElement;

describe('Sidebar channel roving tabindex', () => {
  it('makes only the active channel row tabbable and marks it aria-current', () => {
    renderSidebar({ activeChannelId: 'c2' });
    expect(rowButton('alpha').tabIndex).toBe(-1);
    expect(rowButton('bravo').tabIndex).toBe(0);
    expect(rowButton('charlie').tabIndex).toBe(-1);
    expect(rowButton('bravo').getAttribute('aria-current')).toBe('page');
    expect(rowButton('alpha').getAttribute('aria-current')).toBeNull();
  });

  it('falls back to the first row when the active channel is not in the list', () => {
    renderSidebar({ activeChannelId: null });
    expect(rowButton('alpha').tabIndex).toBe(0);
    expect(rowButton('bravo').tabIndex).toBe(-1);
  });

  it('moves focus and the tabbable row with Arrow/Home/End across the flattened list', () => {
    renderSidebar({ activeChannelId: 'c1' });
    rowButton('alpha').focus();

    fireEvent.keyDown(rowButton('alpha'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowButton('bravo'));
    expect(rowButton('bravo').tabIndex).toBe(0);
    expect(rowButton('alpha').tabIndex).toBe(-1);

    fireEvent.keyDown(rowButton('bravo'), { key: 'End' });
    expect(document.activeElement).toBe(rowButton('charlie'));

    fireEvent.keyDown(rowButton('charlie'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowButton('charlie')); // clamped

    fireEvent.keyDown(rowButton('charlie'), { key: 'Home' });
    expect(document.activeElement).toBe(rowButton('alpha'));

    fireEvent.keyDown(rowButton('alpha'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rowButton('alpha')); // clamped
  });

  it('traverses pinned rows before the rest of the flattened list', () => {
    renderSidebar({
      activeChannelId: 'c1',
      channels: [channel('c1', 'alpha'), channel('p1', 'pinned-one', { pinned: true }), channel('c2', 'bravo')],
    });
    // Pinned rows render first, so the flattened order is [pinned-one, alpha, bravo].
    rowButton('alpha').focus();
    fireEvent.keyDown(rowButton('alpha'), { key: 'Home' });
    expect(document.activeElement).toBe(rowButton('pinned-one'));
  });

  it('re-points the tabbable row when the active channel changes', () => {
    const { rerender, props } = renderSidebar({ activeChannelId: 'c1' });
    expect(rowButton('alpha').tabIndex).toBe(0);

    rerender(<Sidebar {...props} activeChannelId="c3" />);
    expect(rowButton('charlie').tabIndex).toBe(0);
    expect(rowButton('charlie').getAttribute('aria-current')).toBe('page');
    expect(rowButton('alpha').tabIndex).toBe(-1);
  });
});
