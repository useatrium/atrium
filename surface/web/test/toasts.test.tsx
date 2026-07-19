// @vitest-environment jsdom
// The last-resort error surface: handler throws and unhandled rejections
// must become visible toasts, never silent console-only failures.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toasts, showActionToast, showErrorToast } from '../src/components/Toasts';

afterEach(cleanup);

describe('Toasts', () => {
  it('shows imperative error toasts and window error events', async () => {
    render(<Toasts />);

    act(() => showErrorToast('explicit failure'));
    expect(await screen.findByText('explicit failure')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'handler exploded' }));
    });
    expect(await screen.findByText(/handler exploded/)).toBeTruthy();

    // duplicates collapse instead of stacking
    act(() => showErrorToast('explicit failure'));
    expect(screen.getAllByText('explicit failure')).toHaveLength(1);
  });

  it('runs and dismisses a recovery action', async () => {
    const undo = vi.fn();
    render(<Toasts />);

    act(() => showActionToast('Archived one agent.', 'Undo', undo));
    expect(await screen.findByRole('status')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Archived one agent.')).toBeNull();
  });
});
