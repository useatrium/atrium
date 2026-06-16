// @vitest-environment jsdom
// ViewToggle: Channel always enabled; Split/Focus need a session; current view
// is aria-pressed; selecting fires onSetView.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewToggle } from '../src/sessions/ViewToggle';

afterEach(cleanup);

describe('ViewToggle', () => {
  it('disables Split/Focus without a session', () => {
    render(<ViewToggle view="channel" hasSession={false} onSetView={() => {}} />);
    expect((screen.getByRole('button', { name: 'Channel' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Split' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Focus' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks the active segment and routes selections', () => {
    const onSetView = vi.fn();
    render(<ViewToggle view="split" hasSession onSetView={onSetView} />);
    expect(screen.getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(onSetView).toHaveBeenCalledWith('focus');
    fireEvent.click(screen.getByRole('button', { name: 'Channel' }));
    expect(onSetView).toHaveBeenCalledWith('channel');
  });
});
