// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionBanner } from '../src/components/bits';
import { renderWithTheme } from './rnTestUtils';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const baseProps = {
  serverUrl: 'https://atrium.example:3001',
  lastSyncedAt: null,
  onSignInAgain: () => {},
};

describe('ConnectionBanner', () => {
  it('renders nothing when the socket is open', () => {
    renderWithTheme(<ConnectionBanner {...baseProps} status="open" />);

    expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
  });

  it('keeps the reconnecting label during the sustained-failure window', () => {
    renderWithTheme(<ConnectionBanner {...baseProps} status="closed" />);

    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.getByLabelText('Reconnecting…')).toBeInTheDocument();
    expect(screen.queryByText('Sign in again')).not.toBeInTheDocument();
  });

  it('renders the host, last sync time, and sign-in action when unreachable', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T14:00:00.000Z'));
    const onSignInAgain = vi.fn();

    renderWithTheme(
      <ConnectionBanner
        {...baseProps}
        status={{ status: 'unreachable', firstFailedAt: 1, lastCause: 'transport' }}
        lastSyncedAt="2026-07-13T12:00:00.000Z"
        onSignInAgain={onSignInAgain}
      />,
    );

    expect(screen.getByText('Can’t reach atrium.example:3001')).toBeInTheDocument();
    expect(screen.getByText('Saved messages · synced 2h ago')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onSignInAgain).toHaveBeenCalledOnce();
  });
});
