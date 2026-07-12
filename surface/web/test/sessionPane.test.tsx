// @vitest-environment jsdom
// (b) The pane folds the B_tooltest fixture into one Bash tool card whose
// result contains atrium-roundtrip-ok, with a completed status chip.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { forwardRef, useImperativeHandle, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import rawB from '../../centaur-client/test/fixtures/B_tooltest.json';
import { appReducer, initialAppState, type AppState } from '@atrium/surface-client';
import { SessionPane } from '../src/sessions/SessionPane';
import { api } from '../src/api';
import { sessionsApi } from '../src/sessions/api';
import type { Session } from '../src/sessions/types';
import type { UserRef, WireEvent } from '@atrium/surface-client';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

vi.mock('/src/markup/MarkupEditor', () => ({
  MarkupEditor: forwardRef(function MockMarkupEditor(
    {
      initialMarkdown,
      onDirtyChange,
    }: {
      initialMarkdown: string;
      onDirtyChange?: (dirty: boolean) => void;
    },
    ref,
  ) {
    const [value, setValue] = useState(initialMarkdown);
    useImperativeHandle(ref, () => ({
      serialize: () => value,
      hasMarkup: () => value.includes('{++') || value.includes('{--'),
    }));
    return (
      <textarea
        aria-label="Mock markup editor"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onDirtyChange?.(event.target.value !== initialMarkdown);
        }}
      />
    );
  }),
}));

const B = rawB as unknown as CentaurEventFrame[];

const me = { id: 'u-me', handle: 'me', displayName: 'Me' };
const bob = { id: 'u-bob', handle: 'bob', displayName: 'Bob' };
const alice = { id: 'u-alice', handle: 'alice', displayName: 'Alice' };

function bSession(overrides: Partial<Session> = {}): Session {
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
    archivedAt: null,
    pinned: false,
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    lastEventId: 0,
    permalink: '/s/s-b',
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  FakeEventSource.reset();
  installFakeEventSource();
  vi.spyOn(sessionsApi, 'listPresentations').mockResolvedValue({ presentations: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderPaneWithB() {
  render(
    <SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
  );
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
  it('opens the lean pane route from the in-app header', () => {
    render(
      <SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );

    const link = screen.getByRole('link', { name: 'Open agent in a new tab' });
    expect(link.getAttribute('href')).toBe('/s/s-b/pane');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('points the popout header link back to the full app in the same tab', () => {
    render(
      <SessionPane
        session={bSession()}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        popout
      />,
    );

    const link = screen.getByRole('link', { name: 'Open in full app' });
    expect(link.getAttribute('href')).toBe('/s/s-b');
    expect(link.getAttribute('target')).toBeNull();
    expect(link.getAttribute('rel')).toBeNull();
    expect(link.getAttribute('aria-label')).toBe('Open in full app');
  });

  it('opens a session capabilities popover from the header', async () => {
    vi.spyOn(sessionsApi, 'getCapabilities').mockResolvedValue({
      sessionId: 's-b',
      snapshots: [
        {
          parserVersion: 1,
          sessionId: 's-b',
          harness: 'codex',
          sourceSha256: 'abc123456789',
          completeness: 'partial',
          generatedAt: '2026-07-03T00:00:00.000Z',
          runtime: { model: 'gpt-5.5', sandboxPolicy: 'danger-full-access' },
          counts: {
            tools: 1,
            toolNamespaces: 1,
            mcpServers: 0,
            agents: 0,
            skills: 1,
            observedToolCalls: 1,
            changes: 1,
          },
          tools: [{ name: 'functions.exec_command', namespace: 'functions', sources: ['codex.developer_tools'] }],
          toolNamespaces: [{ name: 'functions', sources: ['codex.developer_tools'], count: 1 }],
          mcpServers: [],
          agents: [],
          skills: [{ name: 'stress-test', sources: ['codex.developer_skills'] }],
          observedToolCalls: [
            {
              name: 'exec_command',
              namespace: 'builtin',
              sources: ['codex.function_call'],
              status: 'observed',
              count: 1,
            },
          ],
          pendingMcpServers: [],
          changes: [
            {
              seq: 1,
              line: 3,
              source: 'codex.developer_context',
              summary: 'Developer capability context captured',
              counts: { tools: 1 },
            },
          ],
          warnings: [],
          redactions: ['Codex developer instructions are summarized to capability names and short descriptions.'],
        },
      ],
    });

    render(
      <SessionPane
        session={bSession({ status: 'completed', completedAt: new Date().toISOString() })}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Inspect session capabilities' }));

    expect(await screen.findByRole('dialog', { name: 'Session capabilities' })).toBeTruthy();
    expect(sessionsApi.getCapabilities).toHaveBeenCalledWith('s-b');
    expect(screen.getByRole('button', { name: 'Refresh capabilities' })).toBeTruthy();
    // The dialog mounts a commit before the async capabilities land, so anchor on resolved snapshot content.
    expect(
      await screen.findByText('Codex partial snapshot: 1 tool, 0 MCP servers, 0 agents, 1 skill, 1 observed call.'),
    ).toBeTruthy();
    expect(screen.getByText('functions.exec_command')).toBeTruthy();
    expect(screen.getByText('stress-test')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Filter tools, MCP servers, agents, skills...'), {
      target: { value: 'stress' },
    });
    expect(screen.queryByText('functions.exec_command')).toBeNull();
    expect(screen.getByText('stress-test')).toBeTruthy();
    expect(screen.getByText('Developer capability context captured')).toBeTruthy();
  });

  it('renders generated app presentations in the transcript', async () => {
    vi.mocked(sessionsApi.listPresentations).mockResolvedValue({
      presentations: [
        {
          id: 'artifact-presented:shared/apps/support-triage-console/index.html',
          presentationId: 'presentation-1',
          version: 1,
          appSlug: 'support-triage-console',
          path: 'shared/apps/support-triage-console/index.html',
          title: 'Support Triage Console',
          renderer: 'html-app',
          description: 'Embedded support queue demo.',
          previewUrl: 'index.html?preview=1',
          previewSizePolicy: { enabled: true, defaultSize: 'card' },
          statePolicy: { mode: 'isolated' },
          executionId: null,
          sourceEventIds: [],
        },
      ],
    });

    render(
      <SessionPane
        session={bSession({ status: 'completed', completedAt: new Date().toISOString() })}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('app-presentation-card')).toBeTruthy());
    expect(screen.getByText('Support Triage Console')).toBeTruthy();
    expect(screen.queryByText('Embedded support queue demo.')).toBeNull();
    expect(screen.queryByText('html-app')).toBeNull();
    expect(screen.queryByText('v1')).toBeNull();
    const frame = screen.getByTitle('Support Triage Console preview') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toContain('preview=1');
    expect(frame.className).toContain('h-72');
  });

  it('renders a Claude auth-required banner for the credential owner', () => {
    const onConnect = vi.fn();
    render(
      <SessionPane
        session={bSession({
          providerAuthRequired: {
            provider: 'claude-code',
            userId: me.id,
            reason: 'invalid_token',
            message: 'Claude Code authentication failed.',
            at: new Date().toISOString(),
          },
        })}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        providerCredentials={{
          'claude-code': {
            provider: 'claude-code',
            connected: false,
            status: 'needs_auth',
            lastValidatedAt: null,
            lastError: null,
            updatedAt: null,
          },
        }}
        onConnectProvider={onConnect}
      />,
    );

    expect(screen.getByTestId('provider-auth-banner')).toBeTruthy();
    expect(screen.getByText('needs auth')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Claude' }));
    expect(onConnect).toHaveBeenCalledWith('claude-code');
  });

  it('renders a GitHub auth-required banner on failed private repo checkout', () => {
    const onConnectGitHub = vi.fn();
    render(
      <SessionPane
        session={bSession({
          status: 'failed',
          completedAt: new Date().toISOString(),
          providerAuthRequired: {
            provider: 'github',
            userId: me.id,
            reason: 'invalid_token',
            message: 'GitHub authentication failed. Reconnect GitHub before retrying private repository access.',
            at: new Date().toISOString(),
          },
        })}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        onConnectGitHub={onConnectGitHub}
      />,
    );

    expect(screen.getByTestId('provider-auth-banner')).toBeTruthy();
    expect(screen.getByText(/Reconnect GitHub before retrying private repository access/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect GitHub' }));
    expect(onConnectGitHub).toHaveBeenCalled();
  });

  it('renders the GitHub identity mode used by the session', () => {
    render(
      <SessionPane
        session={bSession({
          repo: 'acme/private',
          githubIdentityMode: 'app_installation',
          providerConnectionId: 'github',
        })}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );

    expect(screen.getByText('GitHub: App installation')).toBeTruthy();
  });

  it('renders one Bash tool card with the roundtrip result, completed status', async () => {
    window.localStorage.setItem('atrium:transcript-view', 'full');
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

    // completed session: a subtle status line reports the turn (meta only). The
    // roundtrip result itself lives in the tool card above — it is not re-carded.
    expect(screen.getByTestId('turn-status').textContent).toContain('Turn complete');
    expect(screen.queryByTestId('turn-card')).toBeNull();
  });

  it('defaults to focus view, groups hidden work, and reveals it from the chip', async () => {
    await renderPaneWithB();

    expect(screen.queryByTestId('tool-card')).toBeNull();
    const chips = screen.getAllByTestId('hidden-work-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('1 work step');

    fireEvent.click(chips[0]!);
    expect(screen.getByTestId('tool-card')).toBeTruthy();
    expect(screen.queryByTestId('hidden-work-chip')).toBeNull();
    expect(window.localStorage.getItem('atrium:transcript-view')).toBe('full');

    fireEvent.click(screen.getByRole('button', { name: 'Hide agent work' }));
    expect(screen.queryByTestId('tool-card')).toBeNull();
    expect(window.localStorage.getItem('atrium:transcript-view')).toBe('focus');
  });

  it('reconnects from the last folded event id on stream error', async () => {
    const es = await renderPaneWithB();
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.useFakeTimers();
    // terminal state reached → an error must NOT trigger a reconnect loop
    await act(async () => {
      es.error();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('resumes with after_event_id=<last seen> when erroring mid-stream', async () => {
    render(
      <SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const es = FakeEventSource.last();
    const firstHalf = B.slice(0, 8); // still running — no terminal state yet
    await act(async () => {
      es.open();
      es.emitAll(firstHalf);
      await new Promise((r) => setTimeout(r, 60));
    });
    const lastSeen = Math.max(...firstHalf.map((f) => f.event_id));
    vi.useFakeTimers();
    await act(async () => {
      es.error();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last().url).toBe(`/api/sessions/s-b/stream?after_event_id=${lastSeen}`);
    expect(es.closed).toBe(true);
  });

  it('does not render the retired comment affordance for a transcript row with a record handle', async () => {
    const frame = {
      event: 'amp_raw_event',
      event_id: 71,
      data: {
        type: 'item.completed',
        item: {
          id: 'agent-row-1',
          type: 'agentMessage',
          text: 'Annotatable agent row',
        },
        recordHandles: [
          {
            handle: 'rec_item_test123',
            kind: 'message',
            actor: 'agent',
            meta: { itemId: 'agent-row-1' },
          },
        ],
      },
    } as CentaurEventFrame;

    render(
      <SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const es = FakeEventSource.last();
    await act(async () => {
      es.open();
      es.emit(frame);
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(screen.getByText('Annotatable agent row')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Comment on entry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy entry link' })).toBeTruthy();
  });

  it('extracts a transcript record and opens the markup pane with frontmatter stripped', async () => {
    const frame = {
      event: 'amp_raw_event',
      event_id: 72,
      data: {
        type: 'item.completed',
        item: {
          id: 'agent-row-2',
          type: 'agentMessage',
          text: 'Markup-ready agent row',
        },
        recordHandles: [
          {
            handle: 'rec_item_markup123',
            kind: 'message',
            actor: 'agent',
            meta: { itemId: 'agent-row-2' },
          },
        ],
      },
    } as CentaurEventFrame;
    vi.spyOn(api, 'extractEntry').mockResolvedValue({
      artifactId: 'art-markup-1',
      path: 'sessions/s-b/markup-ready.md',
      seq: 3,
      workspaceId: 'ws-1',
      sourceText: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('---\ntitle: "Markup Ready"\n---\n\n# Body from artifact\n', {
            status: 200,
            headers: { 'content-type': 'text/markdown' },
          }),
      ),
    );

    render(
      <SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const es = FakeEventSource.last();
    await act(async () => {
      es.open();
      es.emit(frame);
      await new Promise((r) => setTimeout(r, 60));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Mark up & reply' }));

    await waitFor(() => expect(api.extractEntry).toHaveBeenCalledWith('rec_item_markup123'));
    expect(await screen.findByRole('dialog', { name: 'Markup Ready' })).toBeTruthy();
    expect(((await screen.findByLabelText('Mock markup editor')) as HTMLTextAreaElement).value).toBe(
      '# Body from artifact\n',
    );
  });
});

// ---- driver seat (Phase 3) --------------------------------------------------

function seatWire(id: number, type: string, payload: Record<string, unknown>, author: UserRef): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    type,
    actorId: author.id,
    payload,
    createdAt: new Date(id * 1000).toISOString(),
    author,
  };
}

/** App state with session s-b spawned by me — driver defaults to the spawner. */
function spawnedState(): AppState {
  let s = appReducer(initialAppState, {
    type: 'history-loaded',
    channelId: 'ch-1',
    events: [],
    hasMore: false,
  });
  s = appReducer(s, {
    type: 'server-event',
    event: seatWire(
      101,
      'session.spawned',
      { sessionId: 's-b', title: 'probe the toolchain', harness: 'claude-code', by: me.id },
      me,
    ),
  });
  return s;
}

function paneFor(s: AppState, asUser: UserRef = me, watchers: UserRef[] = []) {
  const session = s.sessions['s-b'];
  if (!session) throw new Error('session entity missing');
  return (
    <SessionPane
      session={session}
      me={asUser}
      watchers={watchers}
      onClose={() => {}}
      onAnswerQuestion={async () => {}}
    />
  );
}

function stub202() {
  const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('driver seat', () => {
  it('(a) seat_changed flips composer enablement and header driver live', () => {
    let s = spawnedState();
    const { rerender } = render(paneFor(s));

    // I spawned it → I hold the seat: enabled composer, steer placeholder.
    const boxBefore = screen.getByPlaceholderText(/steer the agent/i);
    expect((boxBefore as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByTestId('driver-chip').textContent).toBe('driver: Me');

    // Bob takes the seat — entity folds the WS event, no refetch.
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(102, 'session.seat_changed', { sessionId: 's-b', from: me.id, to: bob.id, reason: 'taken' }, bob),
    });
    rerender(paneFor(s));

    expect(screen.getByTestId('driver-chip').textContent).toBe('driver: Bob');
    // As a spectator the composer becomes a suggest box (still enabled — you can
    // always propose), not a dead "you can't type" field.
    const boxAfter = screen.getByPlaceholderText(/Suggest a message — Bob decides/);
    expect((boxAfter as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('(b) seat_requested shows the grant banner to the driver only; grant posts the right body', async () => {
    const fetchMock = stub202();
    let s = spawnedState();
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(102, 'session.seat_requested', { sessionId: 's-b', by: bob.id }, bob),
    });
    expect(s.sessions['s-b']!.pendingSeatRequests).toEqual([{ userId: bob.id, displayName: 'Bob' }]);

    // A non-driver spectator never sees the banner.
    const spectator = { id: 'u-carol', handle: 'carol', displayName: 'Carol' };
    const first = render(paneFor(s, spectator));
    expect(screen.queryByTestId('seat-request-banner')).toBeNull();
    first.unmount();

    // The driver does, and Grant posts {userId} to seat/grant.
    render(paneFor(s, me));
    const banner = screen.getByTestId('seat-request-banner');
    expect(banner.textContent).toContain('Bob requests the seat');
    fireEvent.click(within(banner).getByText('Grant'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/sessions/s-b/seat/grant');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ userId: bob.id });

    // Ignore dismisses locally.
    fireEvent.click(within(banner).getByText('Ignore'));
    expect(screen.queryByTestId('seat-request-banner')).toBeNull();
  });

  it('(c) non-driver sees Request seat while the driver watches, and it posts seat/request', async () => {
    const fetchMock = stub202();
    const session = bSession({
      spawnedBy: alice.id,
      spawnerName: alice.displayName,
      driverId: alice.id,
      driverName: alice.displayName,
    });
    render(
      <SessionPane
        session={session}
        me={me}
        watchers={[alice, me]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );

    // Pure spectator: no cancel, no take (driver present), and the composer is
    // a suggest box rather than a steer composer.
    expect(screen.queryByText('Cancel')).toBeNull();
    expect((screen.getByPlaceholderText(/Suggest a message — Alice decides/) as HTMLTextAreaElement).disabled).toBe(
      false,
    );
    expect(screen.queryByText('Take seat')).toBeNull();

    fireEvent.click(screen.getByText('Request seat'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/sessions/s-b/seat/request');
    expect(screen.getByTestId('seat-footer').textContent).toContain('requested — waiting for Alice');
  });

  it('request-seat failures call the shared API error hook and revert the optimistic footer', async () => {
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ error: 'unauthorized', message: 'login expired' }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onApiError = vi.fn();
    const session = bSession({
      spawnedBy: alice.id,
      spawnerName: alice.displayName,
      driverId: alice.id,
      driverName: alice.displayName,
    });
    render(
      <SessionPane
        session={session}
        me={me}
        watchers={[alice, me]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        onApiError={onApiError}
      />,
    );

    fireEvent.click(screen.getByText('Request seat'));
    await waitFor(() => expect(onApiError).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/sessions/s-b/seat/request');
    expect(screen.getByTestId('seat-footer').textContent).toContain('Request seat');
  });

  it('(c) shows Take seat when the driver is absent; 409 falls back to a request', async () => {
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) =>
      String(args[0]).endsWith('/seat/take')
        ? new Response(JSON.stringify({ error: 'seat_held' }), { status: 409 })
        : new Response('{}', { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const session = bSession({
      spawnedBy: alice.id,
      spawnerName: alice.displayName,
      driverId: alice.id,
      driverName: alice.displayName,
    });
    render(
      <SessionPane session={session} me={me} watchers={[me]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );

    expect(screen.queryByText('Request seat')).toBeNull();
    // Two-step: Take seat asks for confirmation before posting.
    fireEvent.click(screen.getByText('Take seat'));
    expect(screen.getByText(/take the seat from Alice/)).toBeTruthy();
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/sessions/s-b/seat/take',
      '/api/sessions/s-b/seat/request',
    ]);
    const footer = screen.getByTestId('seat-footer');
    expect(footer.textContent).toContain('seat held');
    expect(footer.textContent).toContain('requested — waiting for Alice');
  });

  it('(c) a successful take posts only seat/take', async () => {
    const fetchMock = stub202();
    const session = bSession({
      spawnedBy: alice.id,
      spawnerName: alice.displayName,
      driverId: alice.id,
      driverName: alice.displayName,
    });
    render(
      <SessionPane session={session} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    fireEvent.click(screen.getByText('Take seat'));
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/sessions/s-b/seat/take');
  });

  it('declining the take-seat confirm keeps spectating without posting', () => {
    const fetchMock = stub202();
    const session = bSession({
      spawnedBy: alice.id,
      spawnerName: alice.displayName,
      driverId: alice.id,
      driverName: alice.displayName,
    });
    render(
      <SessionPane session={session} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    fireEvent.click(screen.getByText('Take seat'));
    fireEvent.click(screen.getByText('Keep watching'));
    expect(screen.getByText('Take seat')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(d) renders a compact audit line from seat_changed', () => {
    let s = spawnedState();
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(102, 'session.seat_requested', { sessionId: 's-b', by: bob.id }, bob),
    });
    // Granted: the actor is the old driver (me); Bob's name comes from his request.
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(
        103,
        'session.seat_changed',
        { sessionId: 's-b', from: me.id, to: bob.id, reason: 'granted' },
        me,
      ),
    });
    render(paneFor(s, me));

    const line = screen.getByTestId('seat-audit-line');
    expect(line.textContent).toContain('Me granted the seat to Bob');
    expect(line.textContent).toMatch(/\d{2}:\d{2}/);
    // The grant also cleared Bob's pending request.
    expect(s.sessions['s-b']!.pendingSeatRequests).toEqual([]);
    expect(screen.queryByTestId('seat-request-banner')).toBeNull();
  });

  it('grant-seat failures call the shared API error hook', async () => {
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ error: 'forbidden', message: 'only the driver may grant the seat' }), {
          status: 403,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onApiError = vi.fn();
    const state = appReducer(spawnedState(), {
      type: 'server-event',
      event: seatWire(102, 'session.seat_requested', { sessionId: 's-b', by: bob.id }, bob),
    });
    const session = state.sessions['s-b']!;

    render(
      <SessionPane
        session={session}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        onApiError={onApiError}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(onApiError).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/sessions/s-b/seat/grant');
  });

  it('steer failures call the shared API error hook and keep inline retry text', async () => {
    const onApiError = vi.fn();
    const onSteer = vi.fn(async () => {
      throw new Error('login expired');
    });
    render(
      <SessionPane
        session={bSession({ driverId: me.id })}
        me={me}
        watchers={[me]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        onSteer={onSteer}
        onApiError={onApiError}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Steer the agent/), { target: { value: 'check status' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onApiError).toHaveBeenCalledTimes(1));
    expect(onSteer).toHaveBeenCalledWith('s-b', 'check status', undefined);
    expect(screen.getByTestId('steer-error').textContent).toContain('check status');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('stop-turn failures call the shared API error hook', async () => {
    const onApiError = vi.fn();
    const onStopTurn = vi.fn(async () => {
      throw new Error('login expired');
    });
    render(
      <SessionPane
        session={bSession({ driverId: me.id })}
        me={me}
        watchers={[me]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        onStopTurn={onStopTurn}
        onApiError={onApiError}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop turn' }));

    await waitFor(() => expect(onApiError).toHaveBeenCalledTimes(1));
    expect(onStopTurn).toHaveBeenCalledWith('s-b');
    expect(screen.getByRole('button', { name: 'Stop failed — retry' })).toBeTruthy();
  });

  it('Escape stops the active turn for the spawner or driver', async () => {
    const onStopTurn = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <SessionPane
        session={bSession({ driverId: me.id })}
        me={me}
        watchers={[me]}
        onClose={onClose}
        onAnswerQuestion={async () => {}}
        onStopTurn={onStopTurn}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(onStopTurn).toHaveBeenCalledWith('s-b'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape-to-stop yields to local editing and dialog Escape behavior', async () => {
    vi.spyOn(sessionsApi, 'getCapabilities').mockResolvedValue({ sessionId: 's-b', snapshots: [] });
    const onStopTurn = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionPane
        session={bSession({ driverId: me.id })}
        me={me}
        watchers={[me]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        onStopTurn={onStopTurn}
      />,
    );

    fireEvent.keyDown(screen.getByPlaceholderText(/Steer the agent/), { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape', metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect session capabilities' }));
    const dialog = await screen.findByRole('dialog', { name: 'Session capabilities' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(onStopTurn).not.toHaveBeenCalled();
  });

  it('cancel-session failures call the shared API error hook', async () => {
    const onApiError = vi.fn();
    const onCancelSession = vi.fn(async () => {
      throw new Error('login expired');
    });
    render(
      <SessionPane
        session={bSession({ driverId: me.id, status: 'queued' })}
        me={me}
        watchers={[me]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        onCancelSession={onCancelSession}
        onApiError={onApiError}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }));

    await waitFor(() => expect(onApiError).toHaveBeenCalledTimes(1));
    expect(onCancelSession).toHaveBeenCalledWith('s-b');
    expect(screen.getByRole('button', { name: 'Cancel failed — retry' })).toBeTruthy();
  });
});

// ---- HITL answer proposals (Phase 2) ----------------------------------------

describe('answer proposals', () => {
  const question = {
    questionId: 'q1',
    questions: [
      {
        id: 'choice',
        header: 'Decision',
        question: 'Which path?',
        options: [
          { label: 'Fast', description: 'ship it' },
          { label: 'Careful', description: 'go slow' },
        ],
      },
    ],
  };

  it('folds answer_proposed / answer_proposal_resolved onto the entity', () => {
    let s = spawnedState(); // me drives s-b
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(
        400,
        'session.answer_proposed',
        {
          sessionId: 's-b',
          proposalId: 'prop-1',
          questionId: 'q1',
          authorId: bob.id,
          answers: { choice: { answers: ['Fast'] } },
        },
        bob,
      ),
    });
    expect(s.sessions['s-b']!.answerProposals).toEqual([
      expect.objectContaining({
        id: 'prop-1',
        questionId: 'q1',
        authorId: bob.id,
        authorName: 'Bob',
        status: 'pending',
      }),
    ]);
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(
        401,
        'session.answer_proposal_resolved',
        { sessionId: 's-b', proposalId: 'prop-1', status: 'submitted', resolvedBy: me.id },
        me,
      ),
    });
    expect(s.sessions['s-b']!.answerProposals[0]!.status).toBe('submitted');
  });

  it('spectator: the answer form is enabled and Propose posts proposeAnswer', async () => {
    const fetchMock = stub202();
    const session = bSession({
      spawnedBy: alice.id,
      spawnerName: alice.displayName,
      driverId: alice.id,
      driverName: alice.displayName,
      pendingQuestion: question,
    });
    render(
      <SessionPane
        session={session}
        me={me}
        watchers={[alice, me]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );
    fireEvent.click(screen.getByText('Fast'));
    fireEvent.click(screen.getByRole('button', { name: 'Propose answer' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/sessions/s-b/question-proposals');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      questionId: 'q1',
      answers: { choice: { answers: ['Fast'] } },
    });
  });

  it('driver: supports Claude multi-select answers and option previews', async () => {
    const onAnswerQuestion = vi.fn().mockResolvedValue(undefined);
    const session = bSession({
      driverId: me.id,
      pendingQuestion: {
        questionId: 'q-preview',
        questions: [
          {
            id: 'sections',
            header: 'Sections',
            question: 'Which sections should be visible?',
            multiSelect: true,
            options: [
              {
                label: 'Summary',
                description: 'Show the short overview.',
                preview: '┌────────┐\n│Summary │\n└────────┘',
                previewFormat: 'markdown',
              },
              {
                label: 'Timeline',
                description: 'Show recent activity.',
                preview: '<div style="padding:8px;border:1px solid #ddd">Timeline</div>',
                previewFormat: 'html',
              },
            ],
          },
        ],
      },
    });
    render(
      <SessionPane session={session} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={onAnswerQuestion} />,
    );

    expect(screen.getByText('Show the short overview.')).toBeTruthy();
    expect(screen.getByText(/┌────────┐/)).toBeTruthy();
    const htmlPreview = screen.getByTitle('Timeline preview') as HTMLIFrameElement;
    expect(htmlPreview.getAttribute('sandbox')).toBe('');
    expect(htmlPreview.getAttribute('srcdoc')).toContain('Content-Security-Policy');

    fireEvent.click(screen.getByText('Summary'));
    fireEvent.click(screen.getByText('Timeline'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));

    await waitFor(() => expect(onAnswerQuestion).toHaveBeenCalledTimes(1));
    expect(onAnswerQuestion).toHaveBeenCalledWith('s-b', 'q-preview', {
      sections: { answers: ['Summary', 'Timeline'] },
    });
  });

  it('driver: the proposals strip Submit posts resolve {action:submit}', async () => {
    const fetchMock = stub202();
    const session = bSession({
      pendingQuestion: question,
      answerProposals: [
        {
          id: 'prop-1',
          questionId: 'q1',
          authorId: bob.id,
          authorName: 'Bob',
          answers: { choice: { answers: ['Fast'] } },
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(
      <SessionPane session={session} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const strip = screen.getByTestId('answer-proposals');
    expect(within(strip).getByText('Bob')).toBeTruthy();
    expect(within(strip).getByText(/Fast/)).toBeTruthy();
    fireEvent.click(within(strip).getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/sessions/s-b/question-proposals/prop-1/resolve');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ action: 'submit' });
  });

  it('driver: the proposals strip Dismiss posts resolve {action:dismiss}', async () => {
    const fetchMock = stub202();
    const session = bSession({
      pendingQuestion: question,
      answerProposals: [
        {
          id: 'prop-1',
          questionId: 'q1',
          authorId: bob.id,
          authorName: 'Bob',
          answers: { choice: { answers: ['Fast'] } },
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(
      <SessionPane session={session} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const strip = screen.getByTestId('answer-proposals');
    fireEvent.click(within(strip).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ action: 'dismiss' });
  });
});

// ---- focus / detach controls (Phase 3) --------------------------------------

describe('focus + detach controls', () => {
  it('expand toggles focus; detach links to the permalink in a new tab', () => {
    const onToggleFocus = vi.fn();
    const { rerender } = render(
      <SessionPane
        session={bSession()}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        layout="split"
        onToggleFocus={onToggleFocus}
      />,
    );

    // Detach is a new-tab link to the lean standalone pane.
    const detach = screen.getByRole('link', { name: /open agent in a new tab/i });
    expect(detach.getAttribute('href')).toBe('/s/s-b/pane');
    expect(detach.getAttribute('target')).toBe('_blank');

    // Split → the control offers Expand.
    const expand = screen.getByRole('button', { name: /expand to focus/i });
    expect(expand.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(expand);
    expect(onToggleFocus).toHaveBeenCalledTimes(1);

    // Focus → it offers Collapse and reports pressed.
    rerender(
      <SessionPane
        session={bSession()}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        layout="focus"
        onToggleFocus={onToggleFocus}
      />,
    );
    const collapse = screen.getByRole('button', { name: /collapse to split/i });
    expect(collapse.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides the expand control when no handler is given, and detach when pending', () => {
    render(
      <SessionPane
        session={bSession({ id: 'pending:tmp-1', permalink: '' })}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /expand to focus/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /open agent in a new tab/i })).toBeNull();
  });
});

// ---- session typing (Phase 2) -----------------------------------------------

describe('session typing', () => {
  it('renders a "composing…" line from the typers prop', () => {
    const { rerender } = render(
      <SessionPane
        session={bSession()}
        me={me}
        watchers={[]}
        typers={[bob]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );
    expect(screen.getByText('Bob is composing…')).toBeTruthy();

    rerender(
      <SessionPane
        session={bSession()}
        me={me}
        watchers={[]}
        typers={[bob, alice]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );
    expect(screen.getByText('Bob and Alice are composing…')).toBeTruthy();
  });
});

// ---- suggestion queue (Phase 2) ---------------------------------------------

describe('suggestion queue', () => {
  // Bob (a spectator) proposes a steer; the event folds onto the session entity.
  function withSuggestion(s: AppState, id: string, text: string, author: UserRef): AppState {
    return appReducer(s, {
      type: 'server-event',
      event: seatWire(
        Number(id.replace(/\D/g, '')) + 200,
        'session.suggestion_added',
        { sessionId: 's-b', suggestionId: id, authorId: author.id, text },
        author,
      ),
    });
  }

  it('folds suggestion_added onto the queue and renders it on the driver strip', () => {
    const s = withSuggestion(spawnedState(), 'sug-1', 'run the tests', bob); // me drives
    expect(s.sessions['s-b']!.suggestions).toEqual([
      expect.objectContaining({
        id: 'sug-1',
        authorId: bob.id,
        authorName: 'Bob',
        text: 'run the tests',
        status: 'pending',
      }),
    ]);
    render(paneFor(s, me));
    const strip = screen.getByTestId('suggestion-strip');
    expect(within(strip).getByText('Bob')).toBeTruthy();
    expect(within(strip).getByText('run the tests')).toBeTruthy();
  });

  it('suggestion_resolved (sent) records the disposition and clears the pending strip', () => {
    let s = withSuggestion(spawnedState(), 'sug-1', 'run the tests', bob);
    s = appReducer(s, {
      type: 'server-event',
      event: seatWire(
        300,
        'session.suggestion_resolved',
        { sessionId: 's-b', suggestionId: 'sug-1', status: 'sent', resolvedBy: me.id },
        me,
      ),
    });
    const sug = s.sessions['s-b']!.suggestions[0]!;
    expect(sug.status).toBe('sent');
    expect(sug.resolvedBy).toBe(me.id);
    render(paneFor(s, me));
    // Resolved rows persist on the entity but leave the actionable strip.
    expect(screen.queryByTestId('suggestion-strip')).toBeNull();
  });

  it('driver strip: Send posts resolve {action:send}', async () => {
    const fetchMock = stub202();
    render(paneFor(withSuggestion(spawnedState(), 'sug-1', 'run the tests', bob), me));
    fireEvent.click(within(screen.getByTestId('suggestion-strip')).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/sessions/s-b/suggestions/sug-1/resolve');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ action: 'send' });
  });

  it('driver strip: failed resolve calls the shared API hook and keeps an inline error', async () => {
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ error: 'suggestion_stale', message: 'suggestion already resolved' }), {
          status: 409,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onApiError = vi.fn();
    render(
      <SessionPane
        session={withSuggestion(spawnedState(), 'sug-1', 'run the tests', bob).sessions['s-b']!}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        onApiError={onApiError}
      />,
    );

    fireEvent.click(within(screen.getByTestId('suggestion-strip')).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onApiError).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('suggestion already resolved')).toBeTruthy();
  });

  it('driver strip: Edit-then-send posts the edited text', async () => {
    const fetchMock = stub202();
    render(paneFor(withSuggestion(spawnedState(), 'sug-1', 'run the tests', bob), me));
    const strip = screen.getByTestId('suggestion-strip');
    fireEvent.click(within(strip).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(strip).getByLabelText('Edit suggestion'), {
      target: { value: 'run tests -v' },
    });
    fireEvent.click(within(strip).getByRole('button', { name: 'Send edited' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      action: 'send',
      text: 'run tests -v',
    });
  });

  it('driver strip: Dismiss posts {action:dismiss} with an optional note', async () => {
    const fetchMock = stub202();
    render(paneFor(withSuggestion(spawnedState(), 'sug-1', 'run the tests', bob), me));
    const strip = screen.getByTestId('suggestion-strip');
    fireEvent.click(within(strip).getByRole('button', { name: 'Dismiss' }));
    fireEvent.change(within(strip).getByLabelText('Dismiss reason'), {
      target: { value: 'not now' },
    });
    fireEvent.click(within(strip).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      action: 'dismiss',
      note: 'not now',
    });
  });

  it('spectator: suggest box posts createSuggestion; the queue is read-only', async () => {
    const fetchMock = stub202();
    const session = bSession({
      spawnedBy: alice.id,
      spawnerName: alice.displayName,
      driverId: alice.id,
      driverName: alice.displayName,
      suggestions: [
        {
          id: 'sug-9',
          authorId: bob.id,
          authorName: 'Bob',
          text: 'check the logs',
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    render(
      <SessionPane
        session={session}
        me={me}
        watchers={[alice, me]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
      />,
    );

    // The queue is visible to the spectator but carries no actions.
    const strip = screen.getByTestId('suggestion-strip');
    expect(within(strip).getByText('check the logs')).toBeTruthy();
    expect(within(strip).queryByRole('button', { name: 'Send' })).toBeNull();
    expect(within(strip).queryByRole('button', { name: 'Dismiss' })).toBeNull();

    // The composer is an enabled suggest box that posts createSuggestion.
    const box = screen.getByPlaceholderText(/Suggest a message — Alice decides/) as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    fireEvent.change(box, { target: { value: 'try the staging env' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/sessions/s-b/suggestions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ text: 'try the staging env' });
  });
});

describe('work drawer (Phase 4 consolidation)', () => {
  it('the side-effects strip opens the unified work drawer on that tab and toggles closed', async () => {
    await renderPaneWithB();
    // The echo Bash op is classified as a side-effect → the strip appears.
    const strip = screen.getByTestId('sideeffects-strip');
    expect(within(strip).getByText('Actions')).toBeTruthy();
    // Drawer closed until the strip is clicked.
    expect(screen.queryByTestId('work-drawer')).toBeNull();

    fireEvent.click(strip);
    const drawer = screen.getByTestId('work-drawer');
    // Opened on the What it ran tab — the classified command shows in the body.
    expect(within(drawer).getByText(/echo atrium-roundtrip-ok/)).toBeTruthy();
    expect(
      within(drawer)
        .getByRole('tab', { name: /What it ran/ })
        .getAttribute('aria-selected'),
    ).toBe('true');

    // Clicking the same strip again toggles the drawer closed.
    fireEvent.click(strip);
    expect(screen.queryByTestId('work-drawer')).toBeNull();
  });

  it('pinning a split pane collapses to focus; unpinning restores it', async () => {
    const onToggleFocus = vi.fn();
    render(
      <SessionPane
        session={bSession()}
        me={me}
        watchers={[]}
        onClose={() => {}}
        onAnswerQuestion={async () => {}}
        layout="split"
        onToggleFocus={onToggleFocus}
      />,
    );
    const es = FakeEventSource.last();
    await act(async () => {
      es.open();
      es.emitAll(B);
      await new Promise((r) => setTimeout(r, 60));
    });

    fireEvent.click(screen.getByTestId('sideeffects-strip'));
    // Pin → the pane asks the parent to collapse to focus (pane-cap rule).
    fireEvent.click(screen.getByRole('button', { name: 'Pin work drawer' }));
    expect(onToggleFocus).toHaveBeenCalledTimes(1);
    // Unpin → the auto-collapse is reversed.
    fireEvent.click(screen.getByRole('button', { name: 'Unpin work drawer' }));
    expect(onToggleFocus).toHaveBeenCalledTimes(2);
  });
});

describe('inline file changes (Phase 4)', () => {
  const editFrames = [
    {
      event: 'execution_state',
      event_id: 1,
      data: { type: 'execution.state', status: 'running', execution_id: 'exe_x' },
    },
    {
      event: 'amp_raw_event',
      event_id: 2,
      data: {
        type: 'assistant',
        uuid: 'a1',
        message: {
          id: 'am1',
          content: [
            {
              type: 'tool_use',
              id: 'edit-1',
              name: 'Edit',
              input: {
                file_path: '/home/agent/workspace/src/app.ts',
                old_string: 'const a = 1;',
                new_string: 'const a = 2;',
              },
            },
          ],
        },
      },
    },
    {
      event: 'execution_state',
      event_id: 3,
      data: { type: 'execution.state', status: 'completed', result_text: 'ok', execution_id: 'exe_x' },
    },
  ] as unknown as CentaurEventFrame[];

  it('renders a file edit as an inline diff card, not a raw tool card', async () => {
    window.localStorage.setItem('atrium:transcript-view', 'full');
    render(
      <SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const es = FakeEventSource.last();
    await act(async () => {
      es.open();
      es.emitAll(editFrames);
      await new Promise((r) => setTimeout(r, 60));
    });

    // The edit shows as an inline diff card (not the generic raw-JSON tool card).
    const card = screen.getByTestId('inline-file-change');
    expect(within(card).getByText('src/app.ts')).toBeTruthy();
    expect(within(card).getByText('edited')).toBeTruthy();
    expect(screen.queryByTestId('tool-card')).toBeNull();

    // The same edit feeds the Changes strip (one file).
    expect(within(screen.getByTestId('changes-strip')).getByText('· 1')).toBeTruthy();

    // Collapsed by default; expanding reveals the coloured diff.
    expect(within(card).queryByText('+ const a = 2;')).toBeNull();
    fireEvent.click(within(card).getByRole('button'));
    expect(within(card).getByText('+ const a = 2;')).toBeTruthy();
  });

  const codexEditFrames = [
    {
      event: 'execution_state',
      event_id: 1,
      data: { type: 'execution.state', status: 'running', execution_id: 'exe_c' },
    },
    {
      event: 'amp_raw_event',
      event_id: 2,
      data: { type: 'item.completed', item: { id: 'cm1', type: 'agentMessage', text: 'editing the config' } },
    },
    {
      event: 'amp_raw_event',
      event_id: 3,
      data: {
        type: 'item.completed',
        item: {
          id: 'cfc1',
          type: 'fileChange',
          changes: [
            { path: '/home/agent/workspace/src/config.ts', kind: 'update', diff: '@@\n-const x = 1;\n+const x = 2;' },
          ],
        },
      },
    },
    {
      event: 'execution_state',
      event_id: 4,
      data: { type: 'execution.state', status: 'completed', result_text: 'ok', execution_id: 'exe_c' },
    },
  ] as unknown as CentaurEventFrame[];

  it('renders a codex fileChange inline in the transcript (previously drawer-only)', async () => {
    window.localStorage.setItem('atrium:transcript-view', 'full');
    render(
      <SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const es = FakeEventSource.last();
    await act(async () => {
      es.open();
      es.emitAll(codexEditFrames);
      await new Promise((r) => setTimeout(r, 60));
    });

    // Codex edits live in stream.fileChanges (not items); they now render inline
    // as the same diff card Claude/amp edits use, anchored after the message.
    const card = screen.getByTestId('inline-file-change');
    expect(within(card).getByText('src/config.ts')).toBeTruthy();
    expect(within(card).getByText('edited')).toBeTruthy();
    expect(screen.getByText('editing the config')).toBeTruthy();
    // Still feeds the Changes strip (one file) — inline + drawer, one source.
    expect(within(screen.getByTestId('changes-strip')).getByText('· 1')).toBeTruthy();

    // Collapsed by default; expand reveals the codex hunk verbatim.
    expect(within(card).queryByText('+const x = 2;')).toBeNull();
    fireEvent.click(within(card).getByRole('button'));
    expect(within(card).getByText('+const x = 2;')).toBeTruthy();
  });

  it('groups a codex file change anchored inside hidden work into one correctly counted chip', async () => {
    const frames = [
      {
        event: 'execution_state',
        event_id: 1,
        data: { type: 'execution.state', status: 'running', execution_id: 'exe_focus' },
      },
      {
        event: 'amp_raw_event',
        event_id: 2,
        data: { type: 'item.completed', item: { id: 'before', type: 'agentMessage', text: 'before work' } },
      },
      {
        event: 'amp_raw_event',
        event_id: 3,
        data: { type: 'item.completed', item: { id: 'think', type: 'reasoning', text: 'thinking' } },
      },
      {
        event: 'amp_raw_event',
        event_id: 4,
        data: {
          type: 'item.completed',
          item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd', output: '/tmp\n', exit_code: 0 },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 5,
        data: {
          type: 'item.completed',
          item: {
            id: 'focus-change',
            type: 'fileChange',
            changes: [{ path: '/home/agent/workspace/src/focus.ts', kind: 'update', diff: '@@\n-old\n+new' }],
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 6,
        data: {
          type: 'item.completed',
          item: { id: 'cmd-2', type: 'commandExecution', command: 'date', output: 'today\n', exit_code: 0 },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 7,
        data: { type: 'item.completed', item: { id: 'after', type: 'agentMessage', text: 'after work' } },
      },
    ] as unknown as CentaurEventFrame[];

    render(
      <SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const es = FakeEventSource.last();
    await act(async () => {
      es.open();
      es.emitAll(frames);
      await new Promise((r) => setTimeout(r, 60));
    });

    const chips = screen.getAllByTestId('hidden-work-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('4 work steps');

    fireEvent.click(chips[0]!);
    expect(screen.getAllByTestId('tool-card')).toHaveLength(2);
    expect(screen.getByTestId('inline-file-change')).toBeTruthy();
  });
});

describe('artifacts surface (Phase 4)', () => {
  const artifactFrames = [
    {
      event: 'execution_state',
      event_id: 1,
      data: { type: 'execution.state', status: 'running', execution_id: 'exe_a' },
    },
    {
      event: 'artifact.captured',
      event_id: 2,
      data: {
        type: 'artifact.captured',
        artifact_id: 'art-1',
        path: '/tmp/chart.png',
        kind: 'created',
        mime: 'image/png',
        size_bytes: 48210,
        sha256: 'art-1',
        ref: 'blob-1',
      },
    },
    {
      event: 'execution_state',
      event_id: 3,
      data: { type: 'execution.state', status: 'completed', result_text: 'ok', execution_id: 'exe_a' },
    },
  ] as unknown as CentaurEventFrame[];

  it('the artifacts strip opens the work drawer on the What changed tab gallery', async () => {
    render(
      <SessionPane session={bSession()} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const es = FakeEventSource.last();
    await act(async () => {
      es.open();
      es.emitAll(artifactFrames);
      await new Promise((r) => setTimeout(r, 60));
    });

    const strip = screen.getByTestId('artifacts-strip');
    expect(within(strip).getByText('Artifacts')).toBeTruthy();
    expect(within(strip).getByText('· 1')).toBeTruthy();
    expect(screen.queryByTestId('work-drawer')).toBeNull();

    fireEvent.click(strip);
    const drawer = screen.getByTestId('work-drawer');
    expect(
      within(drawer)
        .getByRole('tab', { name: /What changed/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(within(drawer).getByText('Created artifacts')).toBeTruthy();
    // The gallery tile serves bytes via the ledger by-path route (latest for the path).
    const img = within(drawer).getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/sessions/s-b/artifacts/by-path?path=%2Ftmp%2Fchart.png');
  });
});
