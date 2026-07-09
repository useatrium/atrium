// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionBanner } from '../src/components/bits';
import { renderWithTheme } from './rnTestUtils';

afterEach(cleanup);

describe('ConnectionBanner', () => {
  it('renders nothing when the socket is open', () => {
    renderWithTheme(<ConnectionBanner status="open" />);

    expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
  });

  it('shows only the reconnecting label when the socket is closed', () => {
    renderWithTheme(<ConnectionBanner status="closed" />);

    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.getByLabelText('Reconnecting…')).toBeInTheDocument();
  });
});
