// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryQuoteCards, stripYamlFrontmatter } from '../src/components/EntryQuoteCards';
import type { ResolvedEntry } from '../src/lib/entryResolve';
import { pressWhenReady, renderWithTheme } from './rnTestUtils';

vi.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

vi.mock('expo-image', () => ({
  Image: ({
    source,
    testID,
    accessibilityLabel,
  }: {
    source: { uri: string };
    testID?: string;
    accessibilityLabel?: string;
  }) => <div data-testid={testID} data-uri={source.uri} aria-label={accessibilityLabel} />,
}));

vi.mock('../src/lib/prefsStorage', () => ({
  loadCollapsedUnfurls: vi.fn(async () => []),
  persistCollapsedUnfurl: vi.fn(async () => {}),
}));

const baseEntry: ResolvedEntry = {
  handle: 'rec_alpha',
  kind: 'assistant_message',
  actor: 'Agent',
  actorLabel: 'Agent',
  text: 'This is the transcript excerpt that should appear in the quote card.',
  meta: {},
  targetType: 'record',
  sourceRefs: [],
  tombstoned: false,
  location: {
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    channelName: 'general',
    threadRootEventId: null,
    sessionId: 's-1',
    sessionTitle: 'Build the thing',
  },
};

afterEach(cleanup);

describe('EntryQuoteCards', () => {
  it('renders nothing until resolve completes, then opens record links in-app to sessions', async () => {
    const resolveEntry = vi.fn<(handle: string) => Promise<ResolvedEntry | null>>().mockResolvedValue(baseEntry);
    const onOpenSession = vi.fn();
    const onOpenChannel = vi.fn();

    renderWithTheme(
      <EntryQuoteCards
        text="Look at /e/rec_alpha"
        serverUrl="https://atrium.example.test"
        resolveEntry={resolveEntry}
        onOpenChannel={onOpenChannel}
        onOpenSession={onOpenSession}
      />,
    );

    expect(screen.queryByText('This is the transcript excerpt that should appear in the quote card.')).toBeNull();

    await screen.findByText('This is the transcript excerpt that should appear in the quote card.');
    expect(screen.getByText('ASSISTANT MESSAGE')).toBeInTheDocument();
    expect(screen.getByText('Build the thing')).toBeInTheDocument();

    await pressWhenReady(screen.findByRole('button', { name: /ASSISTANT MESSAGE, Build the thing:/ }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('s-1'));
    expect(onOpenChannel).not.toHaveBeenCalled();
  });

  it('opens event and artifact links to channels', async () => {
    const resolveEntry = vi.fn<(handle: string) => Promise<ResolvedEntry | null>>().mockResolvedValue({
      ...baseEntry,
      handle: 'evt_8',
      kind: 'message',
      targetType: 'event',
      location: { ...baseEntry.location, sessionId: null, sessionTitle: null },
    });
    const onOpenChannel = vi.fn();

    renderWithTheme(
      <EntryQuoteCards
        text="See https://atrium.example.test/e/evt_8"
        serverUrl="https://atrium.example.test"
        resolveEntry={resolveEntry}
        onOpenChannel={onOpenChannel}
      />,
    );

    await screen.findByText('This is the transcript excerpt that should appear in the quote card.');
    await waitFor(() => expect(resolveEntry).toHaveBeenCalledWith('evt_8'));

    await pressWhenReady(screen.findByRole('button', { name: /MESSAGE, #general:/ }));
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('ch-1'));
  });

  it('renders artifact CriticMarkup content as a tracked-changes card with an expand footer', async () => {
    const artifactEntry: ResolvedEntry = {
      ...baseEntry,
      handle: 'art_12345678-1234-1234-1234-123456789abc',
      kind: 'artifact',
      targetType: 'artifact',
      text: 'Fallback excerpt',
      location: { ...baseEntry.location, sessionId: null, sessionTitle: null },
    };
    const resolveEntry = vi.fn<(handle: string) => Promise<ResolvedEntry | null>>().mockResolvedValue(artifactEntry);
    const resolveArtifactContent = vi
      .fn<(artifactId: string) => Promise<string | null>>()
      .mockResolvedValue(
        '---\ntitle: Draft\n---\nKeep {--old--} {++new++} {~~rough~>clear~~} {==claim==}{>>Needs source.<<}.',
      );

    renderWithTheme(
      <EntryQuoteCards
        text="See /e/art_12345678-1234-1234-1234-123456789abc"
        serverUrl="https://atrium.example.test"
        resolveEntry={resolveEntry}
        resolveArtifactContent={resolveArtifactContent}
      />,
    );

    expect(await screen.findByTestId('entry-quote-markup-card')).toBeTruthy();
    expect(resolveArtifactContent).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789abc');
    expect(screen.getByText('old')).toBeTruthy();
    expect(screen.getByText('new')).toBeTruthy();
    expect(screen.getByText('rough')).toBeTruthy();
    expect(screen.getByText('clear')).toBeTruthy();
    expect(screen.getByText('claim')).toBeTruthy();
    expect(screen.getByText(/Needs source\./)).toBeTruthy();
    expect(screen.getByText('Show all changes (4)')).toBeTruthy();
    expect(screen.queryByText(/title: Draft/)).toBeNull();
  });

  it('strips YAML frontmatter without touching plain markdown bodies', () => {
    expect(stripYamlFrontmatter('---\ntitle: Draft\n---\n# Body')).toBe('# Body');
    expect(stripYamlFrontmatter('---\r\ntitle: Draft\r\n---\r\n# Body')).toBe('# Body');
    expect(stripYamlFrontmatter('---\ntitle: Draft\n---')).toBe('');
    expect(stripYamlFrontmatter('# Body')).toBe('# Body');
  });

  it('caps previews at three and expands the remaining cards', async () => {
    const handles = ['evt_1', 'evt_2', 'evt_3', 'evt_4'];
    const resolveEntry = vi.fn(async (handle: string) => ({
      ...baseEntry,
      handle,
      text: `Excerpt ${handle}`,
    }));

    renderWithTheme(
      <EntryQuoteCards text="" serverUrl="https://atrium.example.test" handles={handles} resolveEntry={resolveEntry} />,
    );

    await screen.findByText('Excerpt evt_1');
    expect(screen.getByText('Excerpt evt_3')).toBeInTheDocument();
    expect(screen.queryByText('Excerpt evt_4')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more previews' }));
    expect(screen.getByText('Excerpt evt_4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer previews' })).toBeInTheDocument();
  });

  it('shows remove only to the author and suppresses optimistically', async () => {
    const suppressMessageUnfurls = vi.fn(async () => ({ event: {} as never }));
    renderWithTheme(
      <EntryQuoteCards
        text=""
        serverUrl="https://atrium.example.test"
        handles={['rec_alpha']}
        resolveEntry={vi.fn(async () => baseEntry)}
        api={{ suppressMessageUnfurls }}
        unfurlManagement={{ messageEventId: 91, suppressed: ['evt_7'], canManage: true }}
      />,
    );

    await screen.findByRole('button', { name: 'Remove preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove preview' }));
    expect(screen.queryByText(baseEntry.text)).toBeNull();
    expect(suppressMessageUnfurls).toHaveBeenCalledWith(91, ['evt_7', 'rec_alpha']);

    cleanup();
    renderWithTheme(
      <EntryQuoteCards
        text=""
        serverUrl="https://atrium.example.test"
        handles={['rec_alpha']}
        resolveEntry={vi.fn(async () => baseEntry)}
        api={{ suppressMessageUnfurls }}
        unfurlManagement={{ messageEventId: 91, canManage: false }}
      />,
    );
    await screen.findByText(baseEntry.text);
    expect(screen.queryByRole('button', { name: 'Remove preview' })).toBeNull();
  });

  it('renders validated image thumbnails with authenticated file URLs and non-image file chips', async () => {
    const entry: ResolvedEntry = {
      ...baseEntry,
      meta: {
        attachments: [
          { id: 'image-1', filename: 'screen.png', contentType: 'image/png', size: 100, width: 640, height: 480 },
          { id: 'pdf-1', filename: 'brief.pdf', contentType: 'application/pdf', size: 200 },
          { id: 42, filename: 'invalid.png', contentType: 'image/png', size: 1 },
        ],
      },
    };

    renderWithTheme(
      <EntryQuoteCards
        text=""
        serverUrl="https://atrium.example.test/"
        handles={['rec_alpha']}
        resolveEntry={vi.fn(async () => entry)}
        onOpenAttachments={vi.fn()}
      />,
    );

    const thumbnail = await screen.findByTestId('entry-attachment-thumbnail-image-1');
    expect(thumbnail).toHaveAttribute('data-uri', 'https://atrium.example.test/api/files/image-1');
    expect(screen.getByText('brief.pdf')).toBeInTheDocument();
    expect(screen.queryByText('invalid.png')).toBeNull();
  });
});
