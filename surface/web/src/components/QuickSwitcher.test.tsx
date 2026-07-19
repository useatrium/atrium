// @vitest-environment jsdom

import type { Channel } from '@atrium/surface-client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickSwitcher, type QuickSwitcherCommand } from './QuickSwitcher';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function command(id: string, label: string): QuickSwitcherCommand {
  return { id, label, group: 'Agents', keywords: [label], run: vi.fn() };
}

const channels: Channel[] = [];

function renderSwitcher() {
  return render(
    <QuickSwitcher
      channels={channels}
      activeChannelId={null}
      meId="me"
      commands={[command('a', 'Alpha'), command('b', 'Bravo'), command('c', 'Charlie')]}
      onSelect={vi.fn()}
      onJumpToMessage={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe('QuickSwitcher', () => {
  it('scrolls the active option into view as arrow keys move the selection', () => {
    // aria-activedescendant selection doesn't move DOM focus, so jsdom never
    // auto-scrolls; the effect must. jsdom lacks scrollIntoView, so stub it.
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    renderSwitcher();
    const input = screen.getByRole('combobox');

    // Mounts with the first option selected and scrolled into view.
    expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById('quick-switcher-option-0'));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById('quick-switcher-option-1'));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById('quick-switcher-option-2'));
  });
});
