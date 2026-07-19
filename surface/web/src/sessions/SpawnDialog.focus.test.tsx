// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpawnDialog } from './SpawnDialog';

// Mirrors the real invocation: a button opens the dialog, and the dialog is
// conditionally mounted by the parent — so closing unmounts it and useDialog's
// cleanup restores focus.
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="invoker" onClick={() => setOpen(true)}>
        New agent
      </button>
      {open && <SpawnDialog channelName="#eng" onCancel={() => setOpen(false)} onSpawn={vi.fn()} />}
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SpawnDialog accessibility', () => {
  it('labels the dialog by its visible title (no mismatched aria-label)', () => {
    render(<SpawnDialog channelName="#eng" onCancel={vi.fn()} onSpawn={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBeNull();
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBe('spawn-dialog-title');
    expect(document.getElementById(labelId!)?.textContent).toBe('New agent');
  });

  it('returns focus to the invoking button on Escape-close', () => {
    render(<Harness />);
    const invoker = screen.getByTestId('invoker');
    invoker.focus();
    expect(document.activeElement).toBe(invoker);

    fireEvent.click(invoker);
    // The task field autofocuses; the dialog is up.
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });

  it('returns focus to the invoking button on cancel-click', () => {
    render(<Harness />);
    const invoker = screen.getByTestId('invoker');
    invoker.focus();

    fireEvent.click(invoker);
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });
});
