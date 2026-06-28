// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeatAuditLine, SessionTypingLine, TurnRail } from '../src/sessions/SessionActivity';
import type { SeatAuditEntry } from '../src/sessions/types';

afterEach(cleanup);

describe('SessionActivity', () => {
  it('renders session typing labels for none, one, two, and several typers', () => {
    const { rerender } = render(<SessionTypingLine typers={[]} />);
    expect(screen.getByText('', { selector: '[aria-live="polite"]' })).toBeTruthy();

    rerender(<SessionTypingLine typers={[user('Ada')]} />);
    expect(screen.getByText('Ada is composing…')).toBeTruthy();

    rerender(<SessionTypingLine typers={[user('Ada'), user('Grace')]} />);
    expect(screen.getByText('Ada and Grace are composing…')).toBeTruthy();

    rerender(<SessionTypingLine typers={[user('Ada'), user('Grace'), user('Katherine')]} />);
    expect(screen.getByText('Several people are composing…')).toBeTruthy();
  });

  it('renders the turn rail and jumps to selected turns', () => {
    const onJump = vi.fn();
    render(
      <TurnRail
        turns={[
          { id: 'turn-1', text: 'first turn' },
          { id: 'turn-2', text: 'second turn' },
        ]}
        onJump={onJump}
      />,
    );

    expect(screen.getByTestId('turn-rail')).toBeTruthy();
    fireEvent.click(screen.getByText('second turn'));
    expect(onJump).toHaveBeenCalledWith('turn-2');
  });

  it('omits the turn rail when there are no turns', () => {
    const { container } = render(<TurnRail turns={[]} onJump={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders seat audit labels and time', () => {
    const entry: SeatAuditEntry = {
      id: 1,
      from: 'u-old',
      to: 'u-new',
      toName: 'New Driver',
      reason: 'taken',
      at: '2026-06-28T13:05:00.000Z',
    };

    render(<SeatAuditLine entry={entry} nameFor={(id) => (id === 'u-old' ? 'Old Driver' : 'Unknown')} />);

    const text = screen.getByTestId('seat-audit-line').textContent ?? '';
    expect(text).toContain('New Driver took the seat from Old Driver');
    expect(text).toMatch(/\d{2}:\d{2}/);
  });
});

function user(displayName: string) {
  return {
    id: displayName.toLowerCase(),
    handle: displayName.toLowerCase(),
    displayName,
  };
}
