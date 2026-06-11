// @vitest-environment jsdom
// (c) Composer @agent grammar: spawns via POST /api/sessions (with
// threadRootEventId when sent from a thread) instead of posting a message.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppAction } from '@atrium/surface-client';
import { Composer } from '../src/components/Composer';
import { trySpawnFromComposer } from '../src/sessions/spawn';
import type { SessionWire } from '../src/sessions/types';

const me = { id: 'u-me', handle: 'me', displayName: 'Me' };

const wireSession: SessionWire = {
  id: 'sess-9',
  workspaceId: 'ws-1',
  channelId: 'ch-1',
  threadRootEventId: 7,
  title: 'fix the flaky test',
  status: 'spawning',
  harness: 'claude-code',
  spawnedBy: me.id,
  driverId: null,
  costUsd: 0,
  resultText: null,
  createdAt: new Date().toISOString(),
  completedAt: null,
  lastEventId: 0,
  permalink: '/s/sess-9',
};

function stubCreateSession() {
  const fetchMock = vi.fn(
    async (..._args: Parameters<typeof fetch>) =>
      new Response(JSON.stringify({ session: wireSession }), { status: 201 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Same routing Chat.send performs: @agent → session spawn, else message. */
function Harness({
  threadRootEventId,
  dispatch,
  onPlainMessage,
}: {
  threadRootEventId?: number;
  dispatch: (a: AppAction) => void;
  onPlainMessage: (text: string) => void;
}) {
  return (
    <Composer
      placeholder="reply"
      agentAware
      onSend={(text) => {
        if (trySpawnFromComposer(text, { channelId: 'ch-1', threadRootEventId, me, dispatch }))
          return;
        onPlainMessage(text);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function type(value: string) {
  const box = screen.getByPlaceholderText('reply');
  fireEvent.change(box, { target: { value } });
  return box;
}

describe('composer @agent grammar', () => {
  it('posts to /api/sessions with threadRootEventId when in a thread', async () => {
    const fetchMock = stubCreateSession();
    const dispatch = vi.fn();
    const onPlain = vi.fn();
    render(<Harness threadRootEventId={7} dispatch={dispatch} onPlainMessage={onPlain} />);

    const box = type('@agent fix the flaky test');
    // subtle hint chip while the grammar matches
    expect(screen.getByText(/spawns an agent session/)).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onPlain).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/sessions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      channelId: 'ch-1',
      threadRootEventId: 7,
      task: 'fix the flaky test',
    });

    // optimistic card first, reconciled with the 201 response after
    expect(dispatch.mock.calls[0]?.[0]?.type).toBe('session-spawn-pending');
    const pending = dispatch.mock.calls[0]?.[0];
    expect(pending.message.threadRootEventId).toBe(7);
    expect(pending.session.status).toBe('spawning');
    await waitFor(() =>
      expect(dispatch.mock.calls.some((c) => c[0]?.type === 'session-created')).toBe(true),
    );
  });

  it('omits threadRootEventId for channel-level spawns', () => {
    const fetchMock = stubCreateSession();
    render(<Harness dispatch={vi.fn()} onPlainMessage={vi.fn()} />);
    const box = type('@agent summarize today');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      channelId: 'ch-1',
      task: 'summarize today',
    });
  });

  it('leaves plain messages on the message path; bare "@agent" prompts for a task', () => {
    const fetchMock = stubCreateSession();
    const onPlain = vi.fn();
    render(<Harness dispatch={vi.fn()} onPlainMessage={onPlain} />);

    let box = type('deploying in 5');
    expect(screen.queryByText(/spawns an agent session/)).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPlain).toHaveBeenLastCalledWith('deploying in 5');

    // "@agent" with no task never posts the literal string — it keeps the
    // text and asks for a task instead.
    box = type('@agent');
    expect(screen.getByText(/spawns an agent session/)).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByText(/Add a task/)).toBeTruthy();
    expect(onPlain).toHaveBeenCalledTimes(1);
    expect((box as HTMLTextAreaElement).value).toBe('@agent');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
