// @vitest-environment jsdom
// Session-pane UX: (a) transcript turns expose their wall-clock time on
// mouseover (server-stamped frames → item.ts → hover label + title), and
// (b) the split-view pane is drag-resizable with the width persisted.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatTurnTime } from '@atrium/surface-client';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import { SessionPane } from '../src/sessions/SessionPane';
import { sessionsApi } from '../src/sessions/api';
import type { Session } from '../src/sessions/types';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

const me = { id: 'u-me', handle: 'me', displayName: 'Me' };

const running: Session = {
  id: 's-run',
  workspaceId: 'ws-1',
  channelId: 'ch-1',
  threadRootEventId: null,
  title: 'live task',
  status: 'running',
  harness: 'codex',
  spawnedBy: 'u-alice',
  spawnerName: 'Alice',
  driverId: 'u-alice',
  driverName: 'Alice',
  pendingSeatRequests: [],
  suggestions: [],
  answerProposals: [],
  seatEvents: [],
  costUsd: 0,
  resultText: null,
  createdAt: new Date().toISOString(),
  completedAt: null,
  lastEventId: 0,
  permalink: '/s/s-run',
};

beforeEach(() => {
  FakeEventSource.reset();
  installFakeEventSource();
  window.localStorage.clear();
  vi.spyOn(sessionsApi, 'listPresentations').mockResolvedValue({ presentations: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPane(session: Session = running) {
  render(
    <SessionPane session={session} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
  );
  const src = FakeEventSource.last();
  src.open();
  return src;
}

describe('turn timestamps', () => {
  const STAMP = '2026-07-02T10:15:00.000Z';
  const steerFrame: CentaurEventFrame = {
    event: 'amp_raw_event',
    event_id: 2,
    ts: STAMP,
    data: {
      type: 'item.completed',
      item: { id: 'steer-1', type: 'userMessage', content: [{ type: 'text', text: 'fix the parser' }] },
    },
  };

  it('shows a hover timestamp on a stamped steer row', async () => {
    const src = renderPane();
    src.emitAll([
      {
        event: 'execution_state',
        event_id: 1,
        ts: STAMP,
        data: { type: 'execution.state', status: 'running', thread_key: 't', execution_id: 'e' },
      } as CentaurEventFrame,
      steerFrame,
    ]);

    const time = await screen.findByTestId('turn-time');
    expect(time.textContent).toBe(formatTurnTime(STAMP));
    // The row's wrapper carries a native tooltip with the same stamp.
    expect(screen.getByTestId('user-steer').closest('[title]')?.getAttribute('title')).toBe(
      formatTurnTime(STAMP),
    );
  });

  it('renders no timestamp affordance for unstamped frames (older servers)', async () => {
    const src = renderPane();
    src.emitAll([{ ...steerFrame, ts: undefined }]);
    await screen.findByTestId('user-steer');
    expect(screen.queryByTestId('turn-time')).toBeNull();
  });
});

describe('resizable session pane', () => {
  it('renders the adaptive default class until the user drags, then persists the dragged width', async () => {
    renderPane();
    const handle = screen.getByTestId('pane-resize-handle');
    const aside = handle.closest('aside')!;
    // No stored preference → the pre-resize adaptive width (min(520px,42vw)),
    // via class, with no inline width.
    expect(aside.className).toContain('w-[min(520px,42vw)]');
    expect(aside.style.width).toBe('');

    // Drag 140px left → 140px wider (pane is anchored to the right edge; the
    // unmeasurable jsdom rect falls back to the 520px drag baseline).
    // jsdom has no PointerEvent; MouseEvent carries button/clientX and React
    // dispatches by event type, so it stands in fine.
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 800 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 660 }));
    // Mid-drag the width is applied imperatively (no React re-render per move).
    await waitFor(() => expect(aside.style.width).toBe('min(660px, 70vw)'));
    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true, clientX: 660 }));

    expect(window.localStorage.getItem('atrium.sessionPaneWidth')).toBe('660');
  });

  it('restores the persisted width on mount and double-click resets to the adaptive default', async () => {
    window.localStorage.setItem('atrium.sessionPaneWidth', '640');
    renderPane();
    const handle = screen.getByTestId('pane-resize-handle');
    const aside = handle.closest('aside')!;
    expect(aside.style.width).toBe('min(640px, 70vw)');

    fireEvent.doubleClick(handle);
    await waitFor(() => expect(aside.className).toContain('w-[min(520px,42vw)]'));
    expect(aside.style.width).toBe('');
    expect(window.localStorage.getItem('atrium.sessionPaneWidth')).toBeNull();
  });

  it('hides the resize handle in focus layout', () => {
    render(
      <SessionPane
        session={running}
        me={me}
        layout="focus"
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );
    expect(screen.queryByTestId('pane-resize-handle')).toBeNull();
  });
});

describe('effort picker', () => {
  const driving: Session = { ...running, spawnedBy: me.id, driverId: me.id, driverName: 'Me' };

  it('driver on a codex session gets the picker; steers carry the sticky selection', async () => {
    const onSteer = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionPane
        session={driving}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        onSteer={onSteer}
      />,
    );
    FakeEventSource.last().open();

    const picker = await screen.findByTestId('effort-picker');
    const select = picker.querySelector('select')!;
    // No recorded effort yet → "default" is offered.
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'xhigh' } });

    const composer = screen.getByPlaceholderText('Steer the agent...');
    fireEvent.change(composer, { target: { value: 'dig deeper' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(onSteer).toHaveBeenCalledWith(driving.id, 'dig deeper', 'xhigh'));
  });

  it('recorded session effort hides "default" and preselects the level', async () => {
    render(
      <SessionPane
        session={{ ...driving, modelEffort: 'high' }}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );
    FakeEventSource.last().open();
    const picker = await screen.findByTestId('effort-picker');
    const select = picker.querySelector('select')!;
    expect(select.value).toBe('high');
    expect(Array.from(select.options).map((o) => o.value)).not.toContain('');
  });

  it('claude sessions get the picker with the claude vocabulary (incl. max)', async () => {
    render(
      <SessionPane
        session={{ ...driving, harness: 'claude-code' }}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );
    FakeEventSource.last().open();
    const picker = await screen.findByTestId('effort-picker');
    const values = Array.from(picker.querySelector('select')!.options).map((o) => o.value);
    expect(values).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('amp sessions get no picker — no effort knob exists', () => {
    render(
      <SessionPane
        session={{ ...driving, harness: 'amp' }}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );
    FakeEventSource.last().open();
    expect(screen.queryByTestId('effort-picker')).toBeNull();
  });
});
