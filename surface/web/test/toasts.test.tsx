// @vitest-environment jsdom
// The last-resort error surface: handler throws and unhandled rejections
// must become visible toasts, never silent console-only failures.

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Toasts, showErrorToast } from '../src/components/Toasts';

describe('Toasts', () => {
  it('shows imperative error toasts and window error events', async () => {
    render(<Toasts />);

    act(() => showErrorToast('explicit failure'));
    expect(await screen.findByText('explicit failure')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'handler exploded' }));
    });
    expect(await screen.findByText(/handler exploded/)).toBeTruthy();

    // duplicates collapse instead of stacking
    act(() => showErrorToast('explicit failure'));
    expect(screen.getAllByText('explicit failure')).toHaveLength(1);
  });
});
