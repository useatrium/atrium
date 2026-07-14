// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HiddenWorkChip } from '../src/components/HiddenWorkChip';
import { ThemeProvider } from '../src/lib/theme';

describe('HiddenWorkChip', () => {
  it('expands the fold, then a step detail, then opens full output', () => {
    const onShowFull = vi.fn();
    render(
      <ThemeProvider>
        <HiddenWorkChip
          count={2}
          duration="14s"
          steps={[
            {
              id: 'read',
              label: 'Read MessageRow.tsx',
              detail: '1  import React\n2  export function MessageRow()',
              status: 'done',
            },
            { id: 'test', label: 'Run mobile tests', detail: 'vitest run', status: 'running' },
          ]}
          onShowFull={onShowFull}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('▶ ⚙ 2 steps · 14s')).toBeTruthy();
    expect(screen.queryByText('Read MessageRow.tsx')).toBeNull();
    fireEvent.click(screen.getByTestId('hidden-work-chip'));
    expect(screen.getByText('▼ ⚙ 2 steps · 14s')).toBeTruthy();
    expect(screen.getByText('Read MessageRow.tsx')).toBeTruthy();
    expect(screen.queryByText(/export function MessageRow/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Read MessageRow.tsx, done' }));
    expect(screen.getByText(/export function MessageRow/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open full output for Read MessageRow.tsx' }));
    expect(onShowFull).toHaveBeenCalledOnce();
  });
});
