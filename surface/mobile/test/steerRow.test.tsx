// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatTurnTime } from '@atrium/surface-client';
import { SteerRow } from '../src/components/work/SteerRow';
import { renderWithTheme } from './rnTestUtils';

afterEach(cleanup);

describe('SteerRow (mobile)', () => {
  it('shows the steer text with a muted turn timestamp', () => {
    const ts = '2026-07-02T10:15:00.000Z';
    renderWithTheme(<SteerRow text="fix the parser" ts={ts} />);
    expect(screen.getByText('fix the parser')).toBeTruthy();
    expect(screen.getByTestId('steer-time').textContent).toBe(formatTurnTime(ts));
  });

  it('renders text only for unstamped history', () => {
    renderWithTheme(<SteerRow text="old turn" />);
    expect(screen.getByText('old turn')).toBeTruthy();
    expect(screen.queryByTestId('steer-time')).toBeNull();
  });
});
