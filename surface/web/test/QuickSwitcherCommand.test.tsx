// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/api';
import { QuickSwitcher, type QuickSwitcherCommand } from '../src/components/QuickSwitcher';

const channels: Channel[] = [
  { id: 'ch-1', workspaceId: 'ws-1', name: 'general', createdAt: '', archivedAt: null, pinned: false },
  { id: 'ch-2', workspaceId: 'ws-1', name: 'ops', createdAt: '', archivedAt: null, pinned: false },
];

afterEach(cleanup);

function renderSwitcher(commands: QuickSwitcherCommand[]) {
  return render(
    <QuickSwitcher
      channels={channels}
      activeChannelId="ch-1"
      meId="u-me"
      commands={commands}
      onSelect={() => {}}
      onJumpToMessage={() => {}}
      onClose={() => {}}
    />,
  );
}

describe('QuickSwitcher commands', () => {
  it('shows suggested commands before channel results with command-aware labels', () => {
    renderSwitcher([
      {
        id: 'open-files',
        label: 'Open Files',
        subtitle: 'Browse workspace files',
        group: 'Navigate',
        keywords: ['files', 'artifacts'],
        run: () => {},
      },
    ]);

    expect(screen.getByRole('dialog', { name: 'Command center and search' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Commands and search' })).toBeTruthy();
    expect(screen.getByPlaceholderText(/Type a command or search channels, messages, sessions/)).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'Command and search results' })).toBeTruthy();

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toContain('Open Files');
    expect(options[1]?.textContent).toContain('general');
  });

  it('filters commands by keyword and runs the selected command with Enter', () => {
    const openActivity = vi.fn();
    const close = vi.fn();
    render(
      <QuickSwitcher
        channels={channels}
        activeChannelId="ch-1"
        meId="u-me"
        commands={[
          {
            id: 'open-files',
            label: 'Open Files',
            group: 'Navigate',
            keywords: ['files', 'artifacts'],
            run: () => {},
          },
          {
            id: 'open-activity',
            label: 'Open Activity',
            group: 'Navigate',
            keywords: ['mentions', 'updates'],
            run: openActivity,
          },
        ]}
        onSelect={() => {}}
        onJumpToMessage={() => {}}
        onClose={close}
      />,
    );

    const input = screen.getByRole('combobox', { name: 'Commands and search' });
    fireEvent.change(input, { target: { value: 'mentions' } });
    expect(screen.getByText('Open Activity')).toBeTruthy();
    expect(screen.queryByText('Open Files')).toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(openActivity).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
