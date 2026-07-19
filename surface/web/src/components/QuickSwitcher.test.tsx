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

// Mirrors the command Chat.tsx registers for the Mod+. agent-dock toggle.
function toggleDockCommand(run: () => void): QuickSwitcherCommand {
  return {
    id: 'toggle-agent-dock',
    label: 'Toggle agent dock',
    subtitle: 'Show or hide the agents panel',
    group: 'Navigate',
    keywords: ['agent', 'dock', 'panel', 'agents', 'toggle', 'show', 'hide', 'sidebar'],
    run,
  };
}

describe('QuickSwitcher agent-dock command', () => {
  it('surfaces and runs the "Toggle agent dock" command, and matches a "dock" query', () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(
      <QuickSwitcher
        channels={channels}
        activeChannelId={null}
        meId="user-1"
        commands={[toggleDockCommand(run)]}
        onSelect={vi.fn()}
        onJumpToMessage={vi.fn()}
        onClose={onClose}
      />,
    );

    const option = screen.getByRole('option', { name: /Toggle agent dock/ });
    expect(option).toBeTruthy();

    // The keyword list makes it findable by typing "dock".
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dock' } });
    expect(screen.getByRole('option', { name: /Toggle agent dock/ })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
