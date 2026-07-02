// @vitest-environment jsdom
// TurnStatusLine: the pinned status line only claims what the stream proves —
// live shows the heartbeat dot + narrated label, quiet/stuck surface real
// silence (thinking phase only, judged by the caller), reconnecting/reattaching
// replace any activity claim, done keeps the final clock.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnStatusLine } from '../src/sessions/TurnStatus';

afterEach(cleanup);

const base = {
  phase: 'thinking' as const,
  liveness: 'live' as const,
  label: 'Thinking',
  elapsedMs: 72_000,
  quietMs: 0,
  pulse: 3,
  costUsd: 0,
  models: [],
};

describe('TurnStatusLine', () => {
  it('live: heartbeat dot + narrated label + stream-anchored clock', () => {
    render(<TurnStatusLine {...base} label="Isolating the race" />);
    const status = screen.getByTestId('turn-status');
    expect(status.getAttribute('data-liveness')).toBe('live');
    expect(status.textContent).toContain('Isolating the race…');
    expect(status.textContent).toContain('1:12');
    const dot = screen.getByTestId('heartbeat-dot');
    expect(dot.getAttribute('data-parked')).toBeNull();
  });

  it('quiet: parked dot and an honest silence note, clock keeps counting', () => {
    render(<TurnStatusLine {...base} liveness="quiet" quietMs={40_000} />);
    const status = screen.getByTestId('turn-status');
    expect(status.getAttribute('data-liveness')).toBe('quiet');
    expect(status.textContent).toContain('Thinking');
    expect(status.textContent).toContain('quiet for 0:40');
    expect(status.textContent).toContain('1:12');
    expect(screen.getByTestId('heartbeat-dot').getAttribute('data-parked')).toBe('true');
  });

  it('stuck: offers the exit and routes the cancel click', () => {
    const onCancel = vi.fn();
    render(
      <TurnStatusLine
        {...base}
        liveness="stuck"
        quietMs={6 * 60_000}
        cancelLabel="Cancel"
        onCancel={onCancel}
      />,
    );
    const status = screen.getByTestId('turn-status');
    expect(status.textContent).toContain('Still working? No output for 6:00');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('stuck without a seat: no cancel affordance', () => {
    render(<TurnStatusLine {...base} liveness="stuck" quietMs={6 * 60_000} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reconnecting: never claims activity while we cannot hear the agent', () => {
    render(<TurnStatusLine {...base} liveness="reconnecting" label="Isolating the race" />);
    const status = screen.getByTestId('turn-status');
    expect(status.textContent).toContain('Reconnecting…');
    expect(status.textContent).not.toContain('Isolating the race');
    expect(screen.queryByTestId('heartbeat-dot')).toBeNull();
  });

  it('reattaching: names the sandbox pipe recovery', () => {
    render(<TurnStatusLine {...base} phase="tool" liveness="reattaching" />);
    expect(screen.getByTestId('turn-status').textContent).toContain('Reattaching to sandbox…');
  });

  it('done: keeps the turn duration and meta', () => {
    render(
      <TurnStatusLine
        {...base}
        phase="done"
        label="Turn complete"
        elapsedMs={271_000}
        costUsd={0.38}
        models={['gpt-5.5']}
      />,
    );
    const status = screen.getByTestId('turn-status');
    expect(status.getAttribute('data-liveness')).toBeNull();
    expect(status.textContent).toContain('✓ Turn complete');
    expect(status.textContent).toContain('4:31');
    expect(status.textContent).toContain('gpt-5.5');
  });

  it('token counter: estimated shows ≈, real shows the bare count', () => {
    const { rerender } = render(
      <TurnStatusLine {...base} tokens={{ count: 2413, estimated: true }} />,
    );
    expect(screen.getByTestId('token-count').textContent).toBe('≈2,413 tok');
    rerender(<TurnStatusLine {...base} tokens={{ count: 2413, estimated: false }} />);
    expect(screen.getByTestId('token-count').textContent).toBe('2,413 tok');
  });

  it('token counter: hidden when the stream has reported nothing', () => {
    render(<TurnStatusLine {...base} tokens={null} />);
    expect(screen.queryByTestId('token-count')).toBeNull();
  });

  it('waiting: no spinner, no clock — the user is the blocker', () => {
    render(
      <TurnStatusLine {...base} phase="waiting" label="Waiting for your reply" elapsedMs={0} />,
    );
    const status = screen.getByTestId('turn-status');
    expect(status.textContent).toBe('Waiting for your reply');
    expect(screen.queryByTestId('heartbeat-dot')).toBeNull();
  });
});
