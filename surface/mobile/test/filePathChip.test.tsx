// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Text } from 'react-native';
import type { HubFile } from '@atrium/surface-client';
import { parseAgentPathHref } from '@atrium/surface-client/agent-paths';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentFileMarkdownProvider, FilePathChip } from '../src/components/FilePathChip';
import { renderWithTheme } from './rnTestUtils';

vi.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => <Text>{name}</Text>,
  MaterialCommunityIcons: ({ name }: { name: string }) => <Text>{name}</Text>,
}));

const channelId = '121a247c-e270-4783-a9d4-cb80ec984188';
const href = `/home/agent/shared/channels/${channelId}/reports/notes.md`;
const pathRef = parseAgentPathHref(href)!;
const file: HubFile = {
  artifactId: 'artifact-1',
  workspaceId: 'workspace-1',
  path: `shared/channels/${channelId}/reports/notes.md`,
  name: 'notes.md',
  mime: 'text/markdown',
  mediaKind: 'text',
  isText: true,
  sizeBytes: 42,
  origin: 'agent',
  channelId,
  createdAt: '2026-07-14T12:00:00.000Z',
  updatedAt: '2026-07-14T12:00:00.000Z',
  versionSeq: 1,
  labels: [],
  starred: false,
  tombstoned: false,
};

describe('FilePathChip', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders a sandbox path as a file chip with its basename', () => {
    renderWithTheme(<FilePathChip pathRef={pathRef} />);

    expect(screen.getByText('notes.md')).toBeInTheDocument();
    expect(screen.getByLabelText('File unavailable: notes.md')).toBeDisabled();
  });

  it('resolves the canonical path and opens the existing file preview', async () => {
    const onOpenFile = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => file });
    vi.stubGlobal('fetch', fetchMock);
    renderWithTheme(
      <AgentFileMarkdownProvider
        value={{ serverUrl: 'https://atrium.test/', fileHeaders: { Authorization: 'Bearer token' }, onOpenFile }}
      >
        <FilePathChip pathRef={pathRef} />
      </AgentFileMarkdownProvider>,
    );

    fireEvent.click(screen.getByLabelText('Open file notes.md'));

    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(file));
    expect(fetchMock).toHaveBeenCalledWith(
      `https://atrium.test/api/files/by-path?path=${encodeURIComponent(file.path)}`,
      { headers: { Authorization: 'Bearer token' } },
    );
  });

  it('becomes unavailable after the file lookup returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    renderWithTheme(
      <AgentFileMarkdownProvider value={{ serverUrl: 'https://atrium.test', onOpenFile: vi.fn() }}>
        <FilePathChip pathRef={pathRef} />
      </AgentFileMarkdownProvider>,
    );

    fireEvent.click(screen.getByLabelText('Open file notes.md'));

    expect(await screen.findByLabelText('File unavailable: notes.md')).toBeDisabled();
  });

  it('resolves workspace-relative paths through the message channel', async () => {
    const workspaceRef = parseAgentPathHref('/home/agent/reports/local.md')!;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => file });
    vi.stubGlobal('fetch', fetchMock);
    renderWithTheme(
      <AgentFileMarkdownProvider value={{ serverUrl: 'https://atrium.test', channelId, onOpenFile: vi.fn() }}>
        <FilePathChip pathRef={workspaceRef} />
      </AgentFileMarkdownProvider>,
    );

    fireEvent.click(screen.getByLabelText('Open file local.md'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `https://atrium.test/api/files/by-path?path=${encodeURIComponent(`shared/channels/${channelId}/reports/local.md`)}`,
      { headers: undefined },
    );
  });
});
