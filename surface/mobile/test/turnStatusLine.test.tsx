// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnStatusLine } from '../src/components/TurnStatusLine';
import { renderWithTheme } from './rnTestUtils';

afterEach(cleanup);

describe('TurnStatusLine (mobile)', () => {
  it('renders live activity with a heartbeat, headline, and clock', () => {
    renderWithTheme(
      <TurnStatusLine
        phase="thinking"
        liveness="live"
        label="Reading files"
        elapsedMs={72_000}
        quietMs={0}
        pulse={4}
        tokens={null}
        costUsd={0}
        models={[]}
      />,
    );

    expect(screen.getByTestId('turn-status')).toBeTruthy();
    expect(screen.getByTestId('heartbeat-dot')).toBeTruthy();
    expect(screen.getByText('Reading files…')).toBeTruthy();
    expect(screen.getByText('1:12')).toBeTruthy();
  });

  it('renders quiet thinking with a parked heartbeat', () => {
    renderWithTheme(
      <TurnStatusLine
        phase="thinking"
        liveness="quiet"
        label="Thinking"
        elapsedMs={90_000}
        quietMs={31_000}
        pulse={7}
        tokens={null}
        costUsd={0}
        models={[]}
      />,
    );

    expect(screen.getByTestId('heartbeat-dot')).toBeTruthy();
    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.getByText('— quiet for 0:31')).toBeTruthy();
  });

  it('renders stuck thinking and fires stop', () => {
    const onCancel = vi.fn();
    renderWithTheme(
      <TurnStatusLine
        phase="thinking"
        liveness="stuck"
        label="Thinking"
        elapsedMs={360_000}
        quietMs={330_000}
        pulse={8}
        tokens={null}
        costUsd={0}
        models={[]}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('Still working? No output for 5:30')).toBeTruthy();
    fireEvent.click(screen.getByText('Stop'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders reconnecting transport state', () => {
    renderWithTheme(
      <TurnStatusLine
        phase="thinking"
        liveness="reconnecting"
        label="Thinking"
        elapsedMs={72_000}
        quietMs={0}
        pulse={9}
        tokens={null}
        costUsd={0}
        models={[]}
      />,
    );

    expect(screen.getByText('Reconnecting…')).toBeTruthy();
    expect(screen.getByText('1:12')).toBeTruthy();
  });

  it('renders waiting with the wait clock and no heartbeat', () => {
    renderWithTheme(
      <TurnStatusLine
        phase="waiting"
        liveness="live"
        label="Waiting for your reply"
        elapsedMs={72_000}
        quietMs={73_000}
        pulse={10}
        tokens={null}
        costUsd={0}
        models={[]}
      />,
    );

    expect(screen.getByText('Waiting for your reply')).toBeTruthy();
    expect(screen.getByText('1:13')).toBeTruthy();
    expect(screen.queryByTestId('heartbeat-dot')).toBeNull();
  });

  // A finished run reports a duration, not a time of day: "6m", never "6:00".
  it('renders done with a unit-spoken duration and meta', () => {
    renderWithTheme(
      <TurnStatusLine
        phase="done"
        liveness="live"
        label="Turn complete"
        elapsedMs={360_000}
        quietMs={0}
        pulse={11}
        tokens={{ count: 2400, estimated: true }}
        costUsd={0.38}
        models={['gpt-5.5']}
        effort="xhigh"
      />,
    );

    expect(screen.getByText('✓ Turn complete')).toBeTruthy();
    expect(screen.getByText('6m')).toBeTruthy();
    expect(screen.queryByText('6:00')).toBeNull();
    expect(screen.getByTestId('token-count')).toHaveTextContent('≈2.4k tok');
    expect(screen.getByText('$0.38')).toBeTruthy();
    expect(screen.getByText('gpt-5.5 xhigh')).toBeTruthy();
  });

  it('keeps sub-minute and multi-hour done durations in units', () => {
    const done = (elapsedMs: number) => (
      <TurnStatusLine
        phase="done"
        liveness="live"
        label="Turn complete"
        elapsedMs={elapsedMs}
        quietMs={0}
        pulse={1}
        tokens={null}
        costUsd={0}
        models={[]}
      />
    );

    renderWithTheme(done(42_000));
    expect(screen.getByText('42s')).toBeTruthy();
    cleanup();

    renderWithTheme(done(3_900_000));
    expect(screen.getByText('1h 05m')).toBeTruthy();
  });
});
