// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { CallWire } from '@atrium/surface-client';
import { JoinCallStrip } from '../src/components/CallUI';
import { renderWithTheme as renderUI } from './rnTestUtils';

vi.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

afterEach(cleanup);

it('renders a compact rejoin action for a recovered call', () => {
  const onJoin = vi.fn();
  const call: CallWire = {
    id: 'call-1',
    channelId: 'channel-1',
    initiatorId: 'user-2',
    status: 'active',
    startedAt: '2026-07-03T12:00:00.000Z',
    participants: [{ id: 'user-1', handle: 'gary', displayName: 'Gary' }],
  };

  renderUI(<JoinCallStrip call={call} meId="user-1" channelName="Engineering" joining={false} onJoin={onJoin} />);

  expect(screen.getByText('Live call')).toBeInTheDocument();
  expect(screen.getByText('Engineering')).toBeInTheDocument();
  expect(screen.getByText('1 participant')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Rejoin call in Engineering' }));

  expect(onJoin).toHaveBeenCalledTimes(1);
});
