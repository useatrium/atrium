// @vitest-environment jsdom
// Audit-driven polish: message formatting, loading-vs-empty gating, permalink
// failure state, status non-regression, terminal pane read-only.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appReducer, initialAppState, type AppState } from '../src/appState';
import { MessageRow } from '../src/components/MessageRow';
import { MessageText } from '../src/components/MessageText';
import { Timeline } from '../src/components/Timeline';
import type { ChatMessage } from '../src/state';
import { SessionPane } from '../src/sessions/SessionPane';
import {
  isStalledSessionStatus,
  STALLED_AFTER_MS,
  type Session,
} from '../src/sessions/types';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

afterEach(cleanup);

const me = { id: 'u-me', handle: 'me', displayName: 'Me' };

describe('MessageText formatting', () => {
  it('renders fenced code blocks, inline code, and links', () => {
    render(
      <div data-testid="root">
        <MessageText
          text={'see `retry()` here:\n```ts\nconst x = 1;\n```\nhttps://example.com/a?b=1 done'}
        />
      </div>,
    );
    const root = screen.getByTestId('root');
    expect(root.querySelector('pre')?.textContent).toBe('const x = 1;');
    expect(root.querySelector('code')?.textContent).toBe('retry()');
    const a = root.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(root.textContent).toContain('done');
  });

  it('renders plain text unchanged (no formatting tokens)', () => {
    render(
      <div data-testid="plain">
        <MessageText text="deploying in 5" />
      </div>,
    );
    expect(screen.getByTestId('plain').textContent).toBe('deploying in 5');
  });
});

describe('Timeline loading vs empty', () => {
  const common = {
    messages: [],
    hasMoreBefore: false,
    sessions: {},
    spectators: {},
    onLoadEarlier: () => Promise.resolve(),
    onOpenThread: () => {},
    onOpenSession: () => {},
    onRetry: () => {},
  };

  it('never claims "No messages yet" while history is still loading', () => {
    render(<Timeline {...common} loaded={false} />);
    expect(screen.queryByText(/No messages yet/)).toBeNull();
  });

  it('shows the empty state (with the @agent hint) once loaded', () => {
    render(<Timeline {...common} loaded={true} />);
    expect(screen.getByText(/No messages yet/)).toBeTruthy();
    expect(screen.getByText(/@agent/)).toBeTruthy();
  });
});

describe('permalink failure and status regression guards', () => {
  it('session-load-failed flags the open pane; open/close clears it', () => {
    let s: AppState = appReducer(initialAppState, { type: 'open-session', sessionId: 's-x' });
    s = appReducer(s, { type: 'session-load-failed', sessionId: 's-x' });
    expect(s.openSessionError).toBe(true);
    s = appReducer(s, { type: 'close-session' });
    expect(s.openSessionError).toBe(false);
    expect(s.openSessionId).toBeNull();
  });

  it('ignores a load failure for a session that is no longer open', () => {
    let s: AppState = appReducer(initialAppState, { type: 'open-session', sessionId: 's-y' });
    s = appReducer(s, { type: 'session-load-failed', sessionId: 's-other' });
    expect(s.openSessionError).toBe(false);
  });

  it('session-upsert never regresses a status WS already advanced', () => {
    const base: Session = {
      id: 's-z',
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      title: 't',
      status: 'completed',
      harness: 'claude-code',
      spawnedBy: me.id,
      driverId: null,
      pendingSeatRequests: [],
      seatEvents: [],
      costUsd: 0,
      resultText: 'done',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      lastEventId: 5,
      permalink: '/s/s-z',
    };
    let s: AppState = appReducer(initialAppState, { type: 'session-upsert', session: base });
    // A stale GET snapshot from before completion must not roll it back.
    s = appReducer(s, {
      type: 'session-upsert',
      session: { ...base, status: 'running', resultText: null },
    });
    expect(s.sessions['s-z']!.status).toBe('completed');
  });
});

describe('stalled session detection', () => {
  const session = (status: Session['status'], ageMs: number): Session => ({
    id: 's',
    workspaceId: 'w',
    channelId: 'c',
    threadRootEventId: null,
    title: 't',
    status,
    harness: 'claude-code',
    spawnedBy: me.id,
    driverId: null,
    pendingSeatRequests: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    completedAt: null,
    lastEventId: 0,
    permalink: '/s/s',
  });

  it('flags old spawning/queued sessions, not fresh or running ones', () => {
    const now = Date.now();
    expect(isStalledSessionStatus(session('spawning', STALLED_AFTER_MS + 1000), now)).toBe(true);
    expect(isStalledSessionStatus(session('queued', STALLED_AFTER_MS + 1000), now)).toBe(true);
    expect(isStalledSessionStatus(session('spawning', 5000), now)).toBe(false);
    expect(isStalledSessionStatus(session('running', STALLED_AFTER_MS + 1000), now)).toBe(false);
  });
});

describe('message editing', () => {
  const msg = (authorId: string): ChatMessage => ({
    id: 42,
    clientMsgId: 'c1',
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'typo here',
    edited: false,
    author: { id: authorId, handle: 'me', displayName: 'Me' },
    createdAt: new Date().toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
  });

  it('Edit → modify → Enter calls onEdit and closes the editor on success', async () => {
    const onEdit = vi.fn(async () => {});
    render(<MessageRow message={msg(me.id)} grouped={false} meId={me.id} onEdit={onEdit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const box = screen.getByRole('textbox', { name: 'Edit message text' });
    fireEvent.change(box, { target: { value: 'typo fixed' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), 'typo fixed'),
    );
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Edit message text' })).toBeNull(),
    );
  });

  it('offers no Edit button on other people’s messages', () => {
    render(
      <MessageRow message={msg('u-other')} grouped={false} meId={me.id} onEdit={async () => {}} />,
    );
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
  });
});

describe('terminal session pane', () => {
  it('is read-only: no composer, no seat controls, ended notice', () => {
    FakeEventSource.reset();
    installFakeEventSource();
    const done: Session = {
      id: 's-done',
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      title: 'finished task',
      status: 'completed',
      harness: 'claude-code',
      spawnedBy: 'u-alice',
      spawnerName: 'Alice',
      driverId: 'u-alice',
      driverName: 'Alice',
      pendingSeatRequests: [],
      seatEvents: [],
      costUsd: 0.5,
      resultText: 'shipped',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: new Date().toISOString(),
      lastEventId: 9,
      permalink: '/s/s-done',
    };
    render(<SessionPane session={done} me={me} watchers={[]} onClose={() => {}} />);
    expect(screen.getByText(/Session ended/)).toBeTruthy();
    expect(screen.queryByText('Take seat')).toBeNull();
    expect(screen.queryByText('Request seat')).toBeNull();
    expect(screen.queryByPlaceholderText(/Message this session/)).toBeNull();
    expect(screen.queryByText('Cancel')).toBeNull();
    // Transcript replay hasn't finished → loading, not a false "No transcript."
    expect(screen.getByText('Loading transcript…')).toBeTruthy();
  });
});
