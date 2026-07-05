// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kbd } from './Kbd';
import { ShortcutsHelp } from './ShortcutsHelp';
import { Tooltip } from './Tooltip';

afterEach(cleanup);

describe('Kbd', () => {
  it('renders one keycap per chord token (mac glyphs)', () => {
    // navigator.userAgent in jsdom is not mac, so this asserts the fallback path
    const { container } = render(<Kbd keys={['Mod', 'K']} />);
    const caps = container.querySelectorAll('kbd');
    expect(caps.length).toBe(2);
    expect(caps[1]?.textContent).toBe('K');
  });

  it('hides itself from assistive tech when decorative', () => {
    const { container } = render(<Kbd keys={['Enter']} decorative />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('Tooltip', () => {
  it('renders its trigger and does not crash without an ancestor provider', () => {
    render(
      <Tooltip content="Mute channel">
        <button type="button">trigger</button>
      </Tooltip>,
    );
    expect(screen.getByRole('button', { name: 'trigger' })).toBeTruthy();
  });

  it('passes the child through untouched when content is empty', () => {
    render(
      <Tooltip content="">
        <button type="button" data-testid="bare">
          bare
        </button>
      </Tooltip>,
    );
    // No Radix wrapper attributes were added.
    const btn = screen.getByTestId('bare');
    expect(btn.getAttribute('data-state')).toBeNull();
  });
});

describe('ShortcutsHelp', () => {
  it('renders nothing when closed', () => {
    render(<ShortcutsHelp open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders a labelled dialog listing shortcuts when open', () => {
    render(<ShortcutsHelp open onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Send message')).toBeTruthy();
    expect(screen.getByText('Open command palette')).toBeTruthy();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ShortcutsHelp open onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
