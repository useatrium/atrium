// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel, ProviderCredentialStatus } from '../src/api';
import { Sidebar } from '../src/components/Sidebar';
import { ThemeProvider } from '../src/theme';

afterEach(cleanup);

const me = { id: 'u-allan', handle: 'allann', displayName: 'Allan Niemerg' };

function renderSidebar(channels: Channel[]) {
  return render(
    <ThemeProvider>
      <Sidebar
        workspaceName="atrium"
        channels={channels}
        activeChannelId="ch-general"
        unread={{}}
        me={me}
        wsStatus="open"
        onSelect={vi.fn()}
        onSetMute={vi.fn()}
        onCreateChannel={async () => {}}
        onStartDm={vi.fn()}
        onOpenSession={vi.fn()}
        sessionEventSeq={0}
        providerCredentials={{} as Record<string, ProviderCredentialStatus | undefined>}
        onLogout={vi.fn()}
      />
    </ThemeProvider>,
  );
}

describe('Sidebar', () => {
  it('uses the DM partner display name, not the decorated label, for avatar initials', () => {
    renderSidebar([
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'dm-self',
          workspaceId: 'ws-1',
          name: 'dm-self',
          kind: 'dm',
          muted: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          members: [me],
        },
    ]);

    expect(screen.getByText('Allan Niemerg (you)')).toBeTruthy();
    expect(screen.getByTitle('Allan Niemerg').textContent).toBe('AN');
    expect(screen.queryByText('AY')).toBeNull();
  });
});
