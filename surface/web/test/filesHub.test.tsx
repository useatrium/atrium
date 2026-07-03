// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILES_CHANGED_EVENT_TYPE, filesChangedWorkspaceId, useWs, type HubFile, type WireEvent } from '@atrium/surface-client';
import { queryEntryReferencesForHandles } from '../src/components/EntryReferencesChip';
import { FilesHub } from '../src/sessions/FilesHub';
import { ThemeProvider } from '../src/theme';

vi.mock('../src/components/EntryReferencesChip', async () => {
  const actual = await vi.importActual<typeof import('../src/components/EntryReferencesChip')>(
    '../src/components/EntryReferencesChip',
  );
  return {
    ...actual,
    queryEntryReferencesForHandles: vi.fn(),
  };
});

function filesResponse(files: HubFile[] = []) {
  return new Response(JSON.stringify({ files, nextCursor: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const queryEntryReferencesMock = vi.mocked(queryEntryReferencesForHandles);

function hubFile(overrides: Partial<HubFile>): HubFile {
  return {
    artifactId: 'art-1',
    workspaceId: 'ws-1',
    path: 'reports/result.md',
    name: 'result.md',
    mime: 'text/markdown',
    mediaKind: 'text',
    isText: true,
    sizeBytes: 1200,
    origin: 'agent',
    channelId: null,
    sessionId: null,
    sourceMessageId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    versionSeq: 1,
    labels: [],
    starred: false,
    tombstoned: false,
    ...overrides,
  };
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  emit(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
  }
}

function wireEvent(overrides: Partial<WireEvent> = {}): WireEvent {
  return {
    id: 0,
    workspaceId: 'ws-1',
    channelId: null,
    threadRootEventId: null,
    type: FILES_CHANGED_EVENT_TYPE,
    actorId: null,
    payload: { workspaceId: 'ws-1' },
    createdAt: new Date(0).toISOString(),
    author: null,
    ...overrides,
  };
}

function FilesHubWsHarness() {
  const [filesEventSeq, setFilesEventSeq] = useState(0);
  useWs(
    true,
    [],
    {
      onEvent(event) {
        if (filesChangedWorkspaceId(event) === 'ws-1') setFilesEventSeq((n) => n + 1);
      },
      onPresence() {},
      onOpen() {},
      onStatus() {},
    },
    null,
    { url: 'ws://localhost/ws' },
  );
  return <FilesHub workspaceId="ws-1" filesEventSeq={filesEventSeq} />;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => filesResponse());
  vi.stubGlobal('fetch', fetchMock);
  queryEntryReferencesMock.mockResolvedValue({});
  MockWebSocket.instances = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FilesHub', () => {
  it('defaults to channel files when a channel is supplied, then expands to workspace files', async () => {
    render(
      <ThemeProvider>
        <FilesHub workspaceId="ws-1" channelId="ch-1" />
      </ThemeProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const firstRequest = new URL(String(fetchMock.mock.calls[0]![0]), 'http://localhost');
    expect(firstRequest.pathname).toBe('/api/workspaces/ws-1/files');
    expect(firstRequest.searchParams.get('channelId')).toBe('ch-1');
    expect(screen.getByText('Channel files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Channel' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const workspaceRequest = new URL(String(fetchMock.mock.calls.at(-1)![0]), 'http://localhost');
    expect(workspaceRequest.pathname).toBe('/api/workspaces/ws-1/files');
    expect(workspaceRequest.searchParams.has('channelId')).toBe(false);
    expect(screen.getByText('Workspace files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Workspace' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('uses the workspace endpoint when no channel is supplied', async () => {
    render(
      <ThemeProvider>
        <FilesHub workspaceId="ws-1" />
      </ThemeProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/workspaces/ws-1/files');
    expect(screen.queryByRole('group', { name: 'File scope' })).toBeNull();
    expect(screen.getByText('Workspace files')).toBeTruthy();
  });

  it('does not query entry references when the listing is empty', async () => {
    render(
      <ThemeProvider>
        <FilesHub workspaceId="ws-1" />
      </ThemeProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(queryEntryReferencesMock).not.toHaveBeenCalled();
  });

  it('copies artifact entry links from the lightbox copy-link action', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    fetchMock.mockResolvedValue(filesResponse([hubFile({ artifactId: 'art-1', name: 'result.md', path: 'result.md' })]));

    render(
      <ThemeProvider>
        <FilesHub workspaceId="ws-1" />
      </ThemeProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /result\.md/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy file link' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/e/art_art-1`));
  });

  it('shows entry reference chips only for visible files with references', async () => {
    fetchMock.mockResolvedValue(
      filesResponse([
        hubFile({ artifactId: 'art-1', name: 'referenced.md', path: 'referenced.md' }),
        hubFile({ artifactId: 'art-2', name: 'quiet.md', path: 'quiet.md' }),
      ]),
    );
    queryEntryReferencesMock.mockResolvedValue({
      'art_art-1': {
        count: 2,
        latest: [
          {
            eventId: 1,
            handle: 'msg_1',
            channelId: 'ch-1',
            threadRootEventId: null,
            actorLabel: 'Ada',
            excerpt: 'Referenced artifact',
            ts: new Date().toISOString(),
          },
        ],
      },
    });

    render(
      <ThemeProvider>
        <FilesHub workspaceId="ws-1" />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(queryEntryReferencesMock).toHaveBeenCalledWith(['art_art-1', 'art_art-2']),
    );
    expect(await screen.findByRole('button', { name: '2 discussions' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /discussion/ })).toHaveLength(1);
  });

  it('passes entry reference summaries into the open lightbox header', async () => {
    fetchMock.mockResolvedValue(
      filesResponse([hubFile({ artifactId: 'art-1', name: 'referenced.md', path: 'referenced.md' })]),
    );
    queryEntryReferencesMock.mockResolvedValue({
      'art_art-1': {
        count: 1,
        latest: [
          {
            eventId: 1,
            handle: 'msg_1',
            channelId: 'ch-1',
            threadRootEventId: null,
            actorLabel: 'Ada',
            excerpt: 'Referenced artifact',
            ts: new Date().toISOString(),
          },
        ],
      },
    });

    render(
      <ThemeProvider>
        <FilesHub workspaceId="ws-1" />
      </ThemeProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /referenced\.md/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '1 discussion' })).toBeTruthy();
  });

  it('reloads when a files.changed WebSocket event arrives for the workspace', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    render(
      <ThemeProvider>
        <FilesHubWsHarness />
      </ThemeProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    MockWebSocket.instances[0]!.emit({ type: 'event', event: wireEvent(), seq: 1 });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
