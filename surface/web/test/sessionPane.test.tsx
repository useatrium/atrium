// @vitest-environment jsdom
// (b) The pane folds the B_tooltest fixture into one Bash tool card whose
// result contains atrium-roundtrip-ok, with a completed status chip.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import rawB from '../../../packages/centaur-client/test/fixtures/B_tooltest.json';
import { SessionPane } from '../src/sessions/SessionPane';
import type { Session } from '../src/sessions/types';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

const B = rawB as unknown as CentaurEventFrame[];

const me = { id: 'u-me', handle: 'me', displayName: 'Me' };

function bSession(): Session {
  return {
    id: 's-b',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: 'probe the toolchain',
    status: 'running',
    harness: 'claude-code',
    spawnedBy: me.id,
    spawnerName: me.displayName,
    driverId: null,
    costUsd: 0,
    resultText: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    lastEventId: 0,
    permalink: '/s/s-b',
  };
}

beforeEach(() => {
  FakeEventSource.reset();
  installFakeEventSource();
});
afterEach(cleanup);

async function renderPaneWithB() {
  render(<SessionPane session={bSession()} me={me} spectators={0} onClose={() => {}} />);
  const es = FakeEventSource.last();
  expect(es.url).toBe('/api/sessions/s-b/stream?after_event_id=0');
  await act(async () => {
    es.open();
    es.emitAll(B);
    await new Promise((r) => setTimeout(r, 60)); // let the rAF batch flush
  });
  return es;
}

describe('session pane folds the B_tooltest stream', () => {
  it('renders one Bash tool card with the roundtrip result, completed status', async () => {
    await renderPaneWithB();

    // exactly one tool card, named Bash
    const cards = screen.getAllByTestId('tool-card');
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(within(card).getByText('Bash')).toBeTruthy();

    // completed tool calls auto-collapse: command preview, no result yet
    expect(within(card).getByText(/echo atrium-roundtrip-ok/)).toBeTruthy();
    expect(within(card).queryByText(/aarch64/)).toBeNull();

    // expand → full result content
    fireEvent.click(within(card).getByRole('button'));
    const result = within(card).getByText(/aarch64/);
    expect(result.textContent).toContain('atrium-roundtrip-ok');
    expect(result.textContent).toContain('/home/agent/workspace');

    // status chip reached completed (from the terminal execution_state)
    expect(screen.getByText('completed')).toBeTruthy();

    // pinned summary block carries the terminal result_text
    const summary = screen.getByTestId('session-result');
    expect(within(summary).getByText(/TOOLCHAIN_OK: atrium-roundtrip-ok/)).toBeTruthy();
  });

  it('reconnects from the last folded event id on stream error', async () => {
    const es = await renderPaneWithB();
    expect(FakeEventSource.instances).toHaveLength(1);
    // terminal state reached → an error must NOT trigger a reconnect loop
    await act(async () => {
      es.error();
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('resumes with after_event_id=<last seen> when erroring mid-stream', async () => {
    render(<SessionPane session={bSession()} me={me} spectators={0} onClose={() => {}} />);
    const es = FakeEventSource.last();
    const firstHalf = B.slice(0, 8); // still running — no terminal state yet
    await act(async () => {
      es.open();
      es.emitAll(firstHalf);
      await new Promise((r) => setTimeout(r, 60));
    });
    const lastSeen = Math.max(...firstHalf.map((f) => f.event_id));
    await act(async () => {
      es.error();
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last().url).toBe(
      `/api/sessions/s-b/stream?after_event_id=${lastSeen}`,
    );
    expect(es.closed).toBe(true);
  });

  it('disables the composer for spectators with the phase-3 hint', () => {
    const spectator = { id: 'u-other', handle: 'other', displayName: 'Other' };
    render(<SessionPane session={bSession()} me={spectator} spectators={2} onClose={() => {}} />);
    const box = screen.getByPlaceholderText(/spectating — driver seat coming in Phase 3/);
    expect((box as HTMLTextAreaElement).disabled).toBe(true);
    // spectators do not get a cancel button
    expect(screen.queryByText('Cancel')).toBeNull();
  });
});
