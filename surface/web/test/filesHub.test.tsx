// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILES_CHANGED_EVENT_TYPE, filesChangedWorkspaceId, useWs, type WireEvent } from '@atrium/surface-client';
import { FilesHub } from '../src/sessions/FilesHub';
import { ThemeProvider } from '../src/theme';

function filesResponse() {
  return new Response(JSON.stringify({ files: [], nextCursor: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

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
