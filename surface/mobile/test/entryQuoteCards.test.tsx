// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryQuoteCards, stripYamlFrontmatter } from '../src/components/EntryQuoteCards';
import type { ResolvedEntry } from '../src/lib/entryResolve';
import { renderWithTheme } from './rnTestUtils';

vi.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
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
    const resolveEntry = vi.fn<(handle: string) => Promise<ResolvedEntry | null>>()
      .mockResolvedValue(baseEntry);
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

    const excerpt = await screen.findByText('This is the transcript excerpt that should appear in the quote card.');
    expect(screen.getByText('ASSISTANT MESSAGE')).toBeInTheDocument();
    expect(screen.getByText('Build the thing')).toBeInTheDocument();

    fireEvent.click(excerpt);
    expect(onOpenSession).toHaveBeenCalledWith('s-1');
    expect(onOpenChannel).not.toHaveBeenCalled();
  });

  it('opens event and artifact links to channels', async () => {
    const resolveEntry = vi.fn<(handle: string) => Promise<ResolvedEntry | null>>()
      .mockResolvedValue({
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

    const excerpt = await screen.findByText('This is the transcript excerpt that should appear in the quote card.');
    await waitFor(() => expect(resolveEntry).toHaveBeenCalledWith('evt_8'));

    fireEvent.click(excerpt);
    expect(onOpenChannel).toHaveBeenCalledWith('ch-1');
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
    const resolveEntry = vi.fn<(handle: string) => Promise<ResolvedEntry | null>>()
      .mockResolvedValue(artifactEntry);
    const resolveArtifactContent = vi.fn<(artifactId: string) => Promise<string | null>>()
      .mockResolvedValue('---\ntitle: Draft\n---\nKeep {--old--} {++new++} {~~rough~>clear~~} {==claim==}{>>Needs source.<<}.');

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
});
