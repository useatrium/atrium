// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageActionMenu, type MessageActionMenuAction } from './MessageActionMenu';

afterEach(cleanup);

const ACTIONS: MessageActionMenuAction[] = [
  { key: 'copy-text', label: 'Copy text', onSelect: vi.fn() },
  { key: 'select-text', label: 'Select text…', onSelect: vi.fn(), sheetOnly: true },
];

describe('MessageActionMenu sheetOnly actions', () => {
  it('renders sheetOnly actions in the touch sheet', () => {
    render(<MessageActionMenu state={{ mode: 'sheet' }} onClose={vi.fn()} actions={ACTIONS} />);
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Select text…' })).toBeTruthy();
  });

  it('hides sheetOnly actions in the pointer popover (mouse users select natively)', () => {
    render(
      <MessageActionMenu state={{ mode: 'popover', anchor: { x: 10, y: 10 } }} onClose={vi.fn()} actions={ACTIONS} />,
    );
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Select text…' })).toBeNull();
  });
});
