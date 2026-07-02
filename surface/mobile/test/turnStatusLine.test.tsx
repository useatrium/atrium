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

  it('renders stuck thinking and fires cancel', () => {
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
    fireEvent.click(screen.getByText('Cancel'));
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

  it('renders done with final clock and meta', () => {
    renderWithTheme(
      <TurnStatusLine
        phase="done"
        liveness="live"
        label="Turn complete"
        elapsedMs={72_000}
        quietMs={0}
        pulse={11}
        tokens={{ count: 2400, estimated: true }}
        costUsd={0.38}
        models={['gpt-5.5']}
        effort="xhigh"
      />,
    );

    expect(screen.getByText('✓ Turn complete')).toBeTruthy();
    expect(screen.getByText('1:12')).toBeTruthy();
    expect(screen.getByTestId('token-count')).toHaveTextContent('≈2.4k tok');
    expect(screen.getByText('$0.3800')).toBeTruthy();
    expect(screen.getByText('gpt-5.5 xhigh')).toBeTruthy();
  });
});
