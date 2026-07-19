// @vitest-environment jsdom

import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTurnControls } from './useTurnControls';

afterEach(cleanup);

function setup(overrides: Partial<Parameters<typeof useTurnControls>[0]> = {}) {
  const onStopTurn = vi.fn().mockResolvedValue(undefined);
  const onCancelSession = vi.fn().mockResolvedValue(undefined);
  renderHook(() =>
    useTurnControls({
      sessionId: 'session-1',
      canStopTurn: true,
      isSpawner: false,
      isDriver: true,
      visible: true,
      failedCancel: false,
      onStopTurn,
      onCancelSession,
      onClearFailedCancel: vi.fn(),
      reportError: vi.fn(),
      ...overrides,
    }),
  );
  return { onStopTurn, onCancelSession };
}

describe('useTurnControls Escape layer', () => {
  it('stops the running turn on a plain Escape', () => {
    const { onStopTurn } = setup();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onStopTurn).toHaveBeenCalledWith('session-1');
  });

  it('yields Escape to an editable target', () => {
    const { onStopTurn } = setup();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onStopTurn).not.toHaveBeenCalled();
    input.remove();
  });

  it('does not stop a turn from an offscreen (hidden) pane', () => {
    const { onStopTurn } = setup({ visible: false });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onStopTurn).not.toHaveBeenCalled();
  });
});
