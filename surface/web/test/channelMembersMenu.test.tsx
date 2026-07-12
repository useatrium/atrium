// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnqueueOpInput, UserRef } from '@atrium/surface-client';
import type { Channel } from '../src/api';
import { ChannelMembersMenu } from '../src/components/ChannelMembersMenu';
import { ThemeProvider } from '../src/theme';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const me: UserRef = { id: 'u-me', handle: 'me', displayName: 'Me User' };
const ada: UserRef = { id: 'u-ada', handle: 'ada', displayName: 'Ada Lovelace' };
const grace: UserRef = { id: 'u-grace', handle: 'grace', displayName: 'Grace Hopper' };

const channel: Channel = {
  id: 'ch-private',
  workspaceId: 'ws-1',
  name: 'private-room',
  kind: 'private',
  muted: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  members: [me],
  archivedAt: null,
  pinned: false,
};

describe('ChannelMembersMenu', () => {
  it('loads members, queues invites, and confirms leave on the second click', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/channels/ch-private/members')) {
        return new Response(JSON.stringify({ members: [me, ada] }));
      }
      if (url.endsWith('/api/users')) {
        return new Response(JSON.stringify({ users: [me, ada, grace] }));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const enqueueOp = vi.fn(async (_input: EnqueueOpInput<'channel.join' | 'channel.leave'>) => ({
      opId: 'queued-op',
    }));

    render(
      <ThemeProvider>
        <ChannelMembersMenu channel={channel} meId={me.id} enqueueOp={enqueueOp} />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Members' }));
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const inviteGrace = await screen.findByRole('button', { name: /Grace Hopper/ });
    fireEvent.click(inviteGrace);

    await waitFor(() =>
      expect(enqueueOp).toHaveBeenCalledWith(
        expect.objectContaining({
          opType: 'channel.join',
          payload: { channelId: 'ch-private', userId: 'u-grace' },
        }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Leave channel' }));
    expect(enqueueOp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm leave channel' }));

    await waitFor(() =>
      expect(enqueueOp).toHaveBeenCalledWith(
        expect.objectContaining({
          opType: 'channel.leave',
          payload: { channelId: 'ch-private', userId: 'u-me' },
        }),
      ),
    );
  });
});
