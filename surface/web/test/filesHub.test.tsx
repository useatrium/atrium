// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesHub } from '../src/sessions/FilesHub';
import { ThemeProvider } from '../src/theme';

function filesResponse() {
  return new Response(JSON.stringify({ files: [], nextCursor: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => filesResponse());
  vi.stubGlobal('fetch', fetchMock);
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
});
