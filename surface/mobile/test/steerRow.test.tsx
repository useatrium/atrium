// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatExactTimestamp, formatTurnTime } from '@atrium/surface-client';
import { SteerRow } from '../src/components/work/SteerRow';
import { renderWithTheme } from './rnTestUtils';

afterEach(cleanup);

describe('SteerRow (mobile)', () => {
  it('shows the steer text with a muted turn timestamp', () => {
    const ts = '2026-07-02T10:15:00.000Z';
    renderWithTheme(<SteerRow text="fix the parser" ts={ts} />);
    expect(screen.getByText('fix the parser')).toBeTruthy();
    expect(screen.getByTestId('steer-time').textContent).toBe(formatTurnTime(ts));
    expect(screen.getByLabelText(`${formatTurnTime(ts)}. Exact time: ${formatExactTimestamp(ts)}`)).toBeTruthy();
  });

  it('toggles the exact turn timestamp on tap', () => {
    const ts = '2026-07-02T10:15:00.000Z';
    renderWithTheme(<SteerRow text="fix the parser" ts={ts} />);
    const time = screen.getByTestId('steer-time');

    fireEvent.click(time);
    expect(time.textContent).toBe(formatExactTimestamp(ts));

    fireEvent.click(time);
    expect(time.textContent).toBe(formatTurnTime(ts));
  });

  it('renders text only for unstamped history', () => {
    renderWithTheme(<SteerRow text="old turn" />);
    expect(screen.getByText('old turn')).toBeTruthy();
    expect(screen.queryByTestId('steer-time')).toBeNull();
  });

  it('shows an always-visible provenance byline for accepted suggestions', () => {
    renderWithTheme(
      <SteerRow
        text="try a smaller patch"
        provenance={{
          provenance: {
            proposerName: 'Allan',
            resolvedByName: 'Jules',
            edited: false,
            resolvedAt: '2026-07-02T10:15:00.000Z',
          },
          acceptedByMe: true,
        }}
      />,
    );

    const label = 'Proposed by Allan · sent by you';
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByLabelText(label)).toBeTruthy();
  });

  it('marks edited accepted suggestions in the provenance byline', () => {
    renderWithTheme(
      <SteerRow
        text="try a focused patch"
        provenance={{
          provenance: {
            proposerName: 'Allan',
            resolvedByName: 'Dana',
            edited: true,
            resolvedAt: '2026-07-02T10:15:00.000Z',
          },
          acceptedByMe: false,
        }}
      />,
    );

    expect(screen.getByText('Proposed by Allan · sent by Dana · edited')).toBeTruthy();
  });
});
