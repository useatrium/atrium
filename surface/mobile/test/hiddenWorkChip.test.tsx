// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HiddenWorkChip } from '../src/components/HiddenWorkChip';
import { ThemeProvider } from '../src/lib/theme';

describe('HiddenWorkChip', () => {
  it('shows the grouped count and switches to full when tapped', () => {
    const onShowFull = vi.fn();
    render(
      <ThemeProvider>
        <HiddenWorkChip count={12} onShowFull={onShowFull} />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByTestId('hidden-work-chip'));
    expect(screen.getByText('⚙ 12 work steps')).toBeTruthy();
    expect(onShowFull).toHaveBeenCalledOnce();
  });
});
