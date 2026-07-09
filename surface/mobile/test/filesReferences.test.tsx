// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Alert, Pressable, Text, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubFile } from '@atrium/surface-client';
import type { EntryReferenceMap } from '../src/lib/entryReferences';
import { clearArtifactTextSnippetCache } from '../src/lib/artifactTextSnippets';
import { renderWithTheme } from './rnTestUtils';

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
}));
const focusedCallbacks = vi.hoisted(() => new WeakSet<() => void | (() => void)>());

const chatMock = vi.hoisted(() => ({
  api: {
    listWorkspaceFiles: vi.fn(),
    listChannelFiles: vi.fn(),
    fileContentUrl: vi.fn((artifactId: string) => `https://atrium.example.test/api/files/${artifactId}`),
    fileSignedUrl: vi.fn(),
    starFile: vi.fn(),
    unstarFile: vi.fn(),
  },
  fileHeaders: { authorization: 'Bearer test-token' },
  filesEventSeq: 0,
  me: { id: 'u-me', handle: 'me', displayName: 'Me' },
  state: {
    wsStatus: 'open' as const,
    channels: [{ id: 'ch-general', workspaceId: 'ws-1', name: 'general', members: [] }],
  },
}));
const authSessionMock = vi.hoisted(() => ({
  serverUrl: 'https://atrium.example.test',
  token: 'test-token',
  user: { id: 'u-me', handle: 'me', displayName: 'Me' },
}));

vi.mock('expo-router', () => ({
  router: routerMock,
  useLocalSearchParams: () => ({}),
  useFocusEffect: (callback: () => void | (() => void)) => {
    if (focusedCallbacks.has(callback)) return;
    focusedCallbacks.add(callback);
    setTimeout(() => {
      callback();
    }, 0);
  },
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

vi.mock('expo-image', () => ({
  Image: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: unknown }) => children,
}));

vi.mock('../src/lib/chat', () => ({
  useChat: () => chatMock,
}));

vi.mock('../src/lib/session', () => ({
  useRequiredSession: () => authSessionMock,
}));

vi.mock('../src/components/MediaLightbox', () => ({
  mediaIconName: () => 'document-outline',
  thumbnailSource: () => null,
  MediaLightbox: ({
    visible,
    files,
    initialIndex,
    references,
    onOpenReferences,
  }: {
    visible: boolean;
    files: HubFile[];
    initialIndex: number;
    references?: EntryReferenceMap;
    onOpenReferences?: (summary: NonNullable<EntryReferenceMap[string]>) => void;
  }) => {
    if (!visible) return null;
    const file = files[initialIndex];
    const reference = file ? references?.[`art_${file.artifactId}`] : null;
    return (
      <View>
        <Text>Preview {file?.name}</Text>
        {reference && reference.count > 0 && onOpenReferences ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${reference.count} discussion references`}
            onPress={() => onOpenReferences(reference)}
          >
            <Text>↗ {reference.count}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  },
}));

function file(overrides: Partial<HubFile>): HubFile {
  return {
    artifactId: '11111111-1111-1111-1111-111111111111',
    workspaceId: 'ws-1',
    path: 'report.pdf',
    name: 'report.pdf',
    mime: 'application/pdf',
    mediaKind: 'document',
    isText: false,
    sizeBytes: 1024,
    origin: 'upload',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    versionSeq: 1,
    labels: [],
    starred: false,
    tombstoned: false,
    ...overrides,
  };
}

function references(body: EntryReferenceMap) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ references: body }),
  } as Response);
}

function artifactEntryHandle(artifactId: string): string {
  return `art_${artifactId}`;
}

async function renderFilesTab() {
  const { default: FilesTab } = await import('../app/(app)/(tabs)/files');
  return renderWithTheme(<FilesTab />);
}

afterEach(cleanup);

beforeEach(() => {
  clearArtifactTextSnippetCache();
  routerMock.push.mockReset();
  chatMock.api.listWorkspaceFiles.mockReset();
  chatMock.api.listChannelFiles.mockReset();
  chatMock.api.fileContentUrl.mockClear();
  chatMock.api.fileSignedUrl.mockReset();
  chatMock.api.starFile.mockReset();
  chatMock.api.unstarFile.mockReset();
  chatMock.filesEventSeq = 0;
  vi.spyOn(Alert, 'alert').mockImplementation(() => {});
  global.fetch = vi.fn();
});

describe('FilesTab entry references', () => {
  it('shows discussion chips only for referenced files and in the preview header', async () => {
    const referenced = file({ artifactId: '11111111-1111-1111-1111-111111111111', name: 'report.pdf' });
    const unreferenced = file({
      artifactId: '22222222-2222-2222-2222-222222222222',
      path: 'raw.csv',
      name: 'raw.csv',
      mediaKind: 'data',
    });
    chatMock.api.listWorkspaceFiles.mockResolvedValue({ files: [referenced, unreferenced], nextCursor: null });
    vi.mocked(global.fetch).mockImplementation(() =>
      references({
        [artifactEntryHandle(referenced.artifactId)]: {
          count: 2,
          latest: [
            {
              eventId: 10,
              handle: artifactEntryHandle(referenced.artifactId),
              channelId: 'ch-general',
              threadRootEventId: null,
              actorLabel: 'Mina',
              excerpt: 'Used in the report',
              ts: '2026-01-01T00:00:00.000Z',
            },
            {
              eventId: 9,
              handle: artifactEntryHandle(referenced.artifactId),
              channelId: 'ch-random',
              threadRootEventId: 5,
              actorLabel: 'Sam',
              excerpt: 'Mentioned elsewhere',
              ts: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      }),
    );

    await renderFilesTab();

    expect(await screen.findByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('raw.csv')).toBeInTheDocument();
    expect(await screen.findByText('↗ 2')).toBeInTheDocument();
    expect(screen.queryByText('↗ 1')).toBeNull();
    await waitFor(() =>
      expect(chatMock.api.listWorkspaceFiles).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({ includeScratch: false, sort: 'recent' }),
      ),
    );
    const query = chatMock.api.listWorkspaceFiles.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(query).not.toHaveProperty('origin');
    expect(query).not.toHaveProperty('mediaKind');

    fireEvent.click(screen.getByLabelText('report.pdf, PDF'));
    expect(await screen.findByText('Preview report.pdf')).toBeInTheDocument();
    expect(screen.getAllByText('↗ 2')).toHaveLength(2);
  });

  it('sends gallery categories instead of ledger filters', async () => {
    chatMock.api.listWorkspaceFiles.mockResolvedValue({ files: [], nextCursor: null });

    await renderFilesTab();
    await waitFor(() => expect(chatMock.api.listWorkspaceFiles).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('Docs'));

    await waitFor(() => expect(chatMock.api.listWorkspaceFiles).toHaveBeenCalledTimes(2));
    const query = chatMock.api.listWorkspaceFiles.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(query).toEqual(expect.objectContaining({ category: 'doc', includeScratch: false, sort: 'recent' }));
    expect(query).not.toHaveProperty('origin');
    expect(query).not.toHaveProperty('mediaKind');
  });

  it('navigates directly for a single reference', async () => {
    const referenced = file({ artifactId: '33333333-3333-3333-3333-333333333333' });
    chatMock.api.listWorkspaceFiles.mockResolvedValue({ files: [referenced], nextCursor: null });
    vi.mocked(global.fetch).mockImplementation(() =>
      references({
        [artifactEntryHandle(referenced.artifactId)]: {
          count: 1,
          latest: [
            {
              eventId: 12,
              handle: artifactEntryHandle(referenced.artifactId),
              channelId: 'ch-general',
              threadRootEventId: 7,
              actorLabel: 'Mina',
              excerpt: 'Thread mention',
              ts: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      }),
    );

    await renderFilesTab();

    fireEvent.click(await screen.findByText('↗ 1'));

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/thread/[rootId]',
      params: { rootId: '7', channelId: 'ch-general' },
    });
  });

  it('opens the discussed-in action sheet for multiple references', async () => {
    const referenced = file({ artifactId: '44444444-4444-4444-4444-444444444444' });
    chatMock.api.listWorkspaceFiles.mockResolvedValue({ files: [referenced], nextCursor: null });
    vi.mocked(global.fetch).mockImplementation(() =>
      references({
        [artifactEntryHandle(referenced.artifactId)]: {
          count: 2,
          latest: [
            {
              eventId: 12,
              handle: artifactEntryHandle(referenced.artifactId),
              channelId: 'ch-general',
              threadRootEventId: null,
              actorLabel: 'Mina',
              excerpt: 'Channel mention',
              ts: '2026-01-01T00:00:00.000Z',
            },
            {
              eventId: 11,
              handle: artifactEntryHandle(referenced.artifactId),
              channelId: 'ch-random',
              threadRootEventId: 9,
              actorLabel: 'Sam',
              excerpt: 'Thread mention',
              ts: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      }),
    );

    await renderFilesTab();

    fireEvent.click(await screen.findByText('↗ 2'));

    expect(Alert.alert).toHaveBeenCalledWith(
      'Discussed in',
      undefined,
      expect.arrayContaining([
        expect.objectContaining({ text: 'Mina: Channel mention' }),
        expect.objectContaining({ text: 'Sam: Thread mention' }),
      ]),
    );
    const firstAction = vi.mocked(Alert.alert).mock.calls[0]?.[2]?.[0] as { onPress?: () => void };
    firstAction.onPress?.();
    expect(routerMock.push).toHaveBeenCalledWith('/channel/ch-general');
  });

  it('does not fetch references when the listing is empty', async () => {
    chatMock.api.listWorkspaceFiles.mockResolvedValue({ files: [], nextCursor: null });

    await renderFilesTab();

    expect(await screen.findByText('No files')).toBeInTheDocument();
    await waitFor(() => expect(chatMock.api.listWorkspaceFiles).toHaveBeenCalled());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('renders fetched snippets for small text gallery tiles', async () => {
    const textFile = file({
      artifactId: '55555555-5555-5555-5555-555555555555',
      path: 'notes.md',
      name: 'notes.md',
      mime: 'text/markdown',
      mediaKind: 'text',
      isText: true,
      sizeBytes: 120,
      versionSeq: 3,
    });
    chatMock.api.listWorkspaceFiles.mockResolvedValue({ files: [textFile], nextCursor: null });
    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/entries/references/query')) return references({});
      if (url.includes(textFile.artifactId)) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('# Notes\nconst answer = 42;\nmore text'),
        } as Response);
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });

    await renderFilesTab();

    expect(await screen.findByText('notes.md')).toBeInTheDocument();
    expect(await screen.findByText(/const answer = 42/)).toBeInTheDocument();
    expect(chatMock.api.fileContentUrl).toHaveBeenCalledWith(textFile.artifactId);
  });
});
