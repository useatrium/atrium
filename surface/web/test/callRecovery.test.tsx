// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import type { CallWire, UserRef } from '@atrium/surface-client';
import { ChannelCallStrip } from '../src/components/CallUI';
import { ThemeProvider } from '../src/theme';

const me: UserRef = { id: 'u-me', handle: 'me', displayName: 'Me User' };
const ada: UserRef = { id: 'u-ada', handle: 'ada', displayName: 'Ada Lovelace' };

function call(overrides: Partial<CallWire> = {}): CallWire {
  return {
    id: 'call-1',
    channelId: 'ch-1',
    initiatorId: 'u-ada',
    status: 'ringing',
    startedAt: '2026-07-03T14:00:00.000Z',
    participants: [ada],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

function renderStrip(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('ChannelCallStrip', () => {
  it('offers accept and decline for a ringing call from someone else', () => {
    renderStrip(
      <ChannelCallStrip
        call={call()}
        caller={ada}
        channelName="#general"
        meId={me.id}
        joining={false}
        onJoin={() => {}}
        onDecline={() => {}}
      />,
    );

    expect(screen.getByText('Ada Lovelace is calling')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
  });

  it('offers join without decline when the viewer started the ringing call', () => {
    renderStrip(
      <ChannelCallStrip
        call={call({ initiatorId: me.id, participants: [me] })}
        caller={me}
        channelName="#general"
        meId={me.id}
        joining={false}
        onJoin={() => {}}
        onDecline={() => {}}
      />,
    );

    expect(screen.getByText('Call ringing')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rejoin' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('labels a lost local room as rejoin when the viewer is still a participant', () => {
    renderStrip(
      <ChannelCallStrip
        call={call({ status: 'active', participants: [ada, me] })}
        caller={ada}
        channelName="#general"
        meId={me.id}
        joining={false}
        onJoin={() => {}}
        onDecline={() => {}}
      />,
    );

    expect(screen.getByText('Live call')).toBeTruthy();
    expect(screen.getByText('Ada Lovelace, You')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rejoin' })).toBeTruthy();
  });
});
