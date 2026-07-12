// @vitest-environment jsdom
// (c) Composer @agent grammar: queues session.spawn (with threadRootEventId
// when sent from a thread) instead of posting a message.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionFromWire, type AppAction, type SessionSpawnPayload } from '@atrium/surface-client';
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
  archivedAt: null,
  pinned: false,
  costUsd: 0,
  resultText: null,
  createdAt: new Date().toISOString(),
  completedAt: null,
  lastEventId: 0,
  permalink: '/s/sess-9',
};

/** Same routing Chat.send performs: @agent → session spawn, else message. */
function Harness({
  threadRootEventId,
  dispatch,
  enqueueSpawn,
  onPlainMessage,
}: {
  threadRootEventId?: number;
  dispatch: (a: AppAction) => void;
  enqueueSpawn: (payload: SessionSpawnPayload) => void;
  onPlainMessage: (text: string) => void;
}) {
  return (
    <Composer
      placeholder="reply"
      agentAware
      onSend={(text) => {
        if (trySpawnFromComposer(text, { channelId: 'ch-1', threadRootEventId, me, dispatch, enqueueSpawn }))
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
  it('queues session.spawn with threadRootEventId when in a thread', () => {
    const dispatch = vi.fn();
    const enqueueSpawn = vi.fn((payload: SessionSpawnPayload) => {
      dispatch({
        type: 'session-created',
        channelId: payload.channelId,
        tempId: payload.clientSpawnId,
        session: sessionFromWire({
          ...wireSession,
          channelId: payload.channelId,
          threadRootEventId: payload.threadRootEventId ?? null,
          title: payload.task,
        }),
      });
    });
    const onPlain = vi.fn();
    render(
      <Harness
        threadRootEventId={7}
        dispatch={dispatch}
        enqueueSpawn={enqueueSpawn}
        onPlainMessage={onPlain}
      />,
    );

    const box = type('@agent fix the flaky test');
    // subtle hint chip while the grammar matches
    expect(screen.getByText(/— spawns an agent/)).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onPlain).not.toHaveBeenCalled();
    expect(enqueueSpawn).toHaveBeenCalledTimes(1);
    const body = enqueueSpawn.mock.calls[0]![0];
    expect(body).toMatchObject({
      channelId: 'ch-1',
      threadRootEventId: 7,
      task: 'fix the flaky test',
    });
    // the optimistic id rides along so a lost response still reconciles
    expect(body.clientSpawnId).toMatch(/^pending:/);

    // optimistic card first, reconciled with the 201 response after
    expect(dispatch.mock.calls[0]?.[0]?.type).toBe('session-spawn-pending');
    const pending = dispatch.mock.calls[0]?.[0];
    expect(pending.message.threadRootEventId).toBe(7);
    expect(pending.session.status).toBe('spawning');
    expect(dispatch.mock.calls.some((c) => c[0]?.type === 'session-created')).toBe(true);
  });

  it('omits threadRootEventId for channel-level spawns', () => {
    const enqueueSpawn = vi.fn();
    render(<Harness dispatch={vi.fn()} enqueueSpawn={enqueueSpawn} onPlainMessage={vi.fn()} />);
    const box = type('@agent summarize today');
    fireEvent.keyDown(box, { key: 'Enter' });
    const channelBody = enqueueSpawn.mock.calls[0]?.[0];
    expect(channelBody).toMatchObject({
      channelId: 'ch-1',
      task: 'summarize today',
    });
    expect(channelBody.threadRootEventId).toBeUndefined();
    expect(channelBody.clientSpawnId).toMatch(/^pending:/);
  });

  it('leaves plain messages on the message path; bare "@agent" prompts for a task', () => {
    const enqueueSpawn = vi.fn();
    const onPlain = vi.fn();
    render(<Harness dispatch={vi.fn()} enqueueSpawn={enqueueSpawn} onPlainMessage={onPlain} />);

    let box = type('deploying in 5');
    expect(screen.queryByText(/— spawns an agent/)).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPlain).toHaveBeenLastCalledWith('deploying in 5');

    // "@agent" with no task never posts the literal string — it keeps the
    // text and asks for a task instead.
    box = type('@agent');
    expect(screen.getByText(/— spawns an agent/)).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByText(/Add a task/)).toBeTruthy();
    expect(onPlain).toHaveBeenCalledTimes(1);
    expect((box as HTMLTextAreaElement).value).toBe('@agent');

    expect(enqueueSpawn).not.toHaveBeenCalled();
  });
});
