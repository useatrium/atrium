// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryInlineChip, EntryQuoteCard } from './EntryQuoteCard';
import { clearEntryResolveCacheForTests, type ResolvedEntryQuote } from '../lib/entryLinks';

const resolveEntryMock = vi.hoisted(() => vi.fn());

const observers: MockResizeObserver[] = [];

// The clamp measures once on mount and then re-measures through a ResizeObserver,
// which jsdom does not implement. Markup arrives after the mount measurement, so
// growing the card only reaches the clamp through the observer.
class MockResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }

  observe(_target: Element) {}

  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function setMetrics(element: Element, scrollHeight: number, clientHeight: number) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
  });
}

vi.mock('../api', () => ({
  api: {
    resolveEntry: resolveEntryMock,
  },
}));

function entry(overrides: Partial<ResolvedEntryQuote> = {}): ResolvedEntryQuote {
  return {
    handle: 'evt_1',
    kind: 'message',
    actor: 'Ada',
    actorLabel: 'Ada',
    text: 'This is the quoted entry text with useful context.',
    meta: {},
    targetType: 'event',
    tombstoned: false,
    location: {
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      channelName: 'general',
      sessionId: 'session-1',
      sessionTitle: 'Planning session',
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearEntryResolveCacheForTests();
  resolveEntryMock.mockReset();
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('entry links', () => {
  it('renders an excerpt, context, and click-through target', () => {
    render(
      <EntryQuoteCard
        entry={entry({
          text: `${'A'.repeat(210)} trailing text`,
          targetType: 'record',
        })}
      />,
    );

    expect(screen.getByText(/^A{197}\.\.\.$/)).toBeTruthy();
    expect(screen.getByText('#general - Planning session')).toBeTruthy();
    expect(screen.getAllByRole('link').every((link) => link.getAttribute('href') === '/e/evt_1')).toBe(true);
    expect(screen.getByText('Transcript record')).toBeTruthy();
  });

  it('renders a muted deleted-entry card for tombstoned entries', () => {
    render(
      <EntryQuoteCard
        entry={entry({
          tombstoned: true,
          text: 'Hidden text',
          targetType: 'artifact',
        })}
      />,
    );

    expect(screen.getByText('deleted entry')).toBeTruthy();
    expect(screen.queryByText('Hidden text')).toBeNull();
    expect(screen.getByText('#general - Planning session')).toBeTruthy();
  });

  it('renders a resolved inline chip with an artifact basename', async () => {
    resolveEntryMock.mockResolvedValue(
      entry({
        handle: 'art_00000000-0000-0000-0000-000000000001',
        targetType: 'artifact',
        text: 'artifact body',
        meta: { path: 'docs/memo.md' },
      }),
    );

    render(<EntryInlineChip handle="art_00000000-0000-0000-0000-000000000001" />);

    expect(screen.getByRole('link').getAttribute('href')).toBe('/e/art_00000000-0000-0000-0000-000000000001');
    expect(screen.getByText('entry')).toBeTruthy();
    expect(await screen.findByText('memo.md')).toBeTruthy();
  });

  it('renders a generic inline chip when resolving fails', async () => {
    resolveEntryMock.mockRejectedValue(new Error('not found'));

    render(<EntryInlineChip handle="evt_404" />);

    expect(await screen.findByText('Atrium entry')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/e/evt_404');
  });

  function renderMarkupCard() {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Length': '180',
          'X-Artifact-Seq': '4',
        }),
        text: vi
          .fn()
          .mockResolvedValue(
            [
              '---',
              'title: "Edited memo"',
              '---',
              '',
              '# Memo',
              'Keep {--old--}{++new++} wording.',
              '{==Check this==}{>>needs source<<}',
            ].join('\n'),
          ),
      }),
    );

    return render(
      <EntryQuoteCard
        entry={entry({
          handle: 'art_00000000-0000-0000-0000-000000000001',
          targetType: 'artifact',
          text: 'memo.md',
          meta: {
            artifactId: '00000000-0000-0000-0000-000000000001',
            path: 'docs/memo.md',
          },
        })}
      />,
    );
  }

  it('upgrades small markup artifacts into a tracked-changes card', async () => {
    renderMarkupCard();

    expect(screen.getAllByText('memo.md').length).toBeGreaterThan(0);
    expect(await screen.findByText('Edited memo')).toBeTruthy();
    expect(screen.getByText('markup')).toBeTruthy();
    expect(screen.getByText('old').className).toContain('atrium-critic-view-del');
    expect(screen.getByText('new').className).toContain('atrium-critic-view-ins');
    // The toggle is measured, not assumed: a diff this short leaves nothing
    // hidden, so neither a control nor a fade is offered for it.
    expect(screen.queryByRole('button', { name: /Show all changes/ })).toBeNull();
    expect(screen.queryByTestId('markup-clamp-fade')).toBeNull();
  });

  it('measures the clamp even though the markup mounts after the fetch resolves', async () => {
    renderMarkupCard();
    await screen.findByText('Edited memo');

    const clamped = screen.getByText('old').closest('.overflow-hidden');
    expect(clamped).toBeTruthy();
    setMetrics(clamped!, 600, 314);
    act(() => {
      for (const observer of observers) observer.trigger();
    });

    expect(screen.getByTestId('markup-clamp-fade')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all changes (2)' }));
    expect(screen.getByRole('button', { name: 'Show fewer changes' })).toBeTruthy();
    // Expanding releases the clip and the fade, so the whole diff is reachable.
    expect(screen.getByText('old').closest('.overflow-hidden')).toBeNull();
    expect(screen.queryByTestId('markup-clamp-fade')).toBeNull();
  });

  it('leaves non-markup artifact cards on the excerpt renderer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Length': '32',
          'X-Artifact-Seq': '3',
        }),
        text: vi.fn().mockResolvedValue('# Plain doc\nNo tracked changes.\n'),
      }),
    );

    render(
      <EntryQuoteCard
        entry={entry({
          handle: 'art_00000000-0000-0000-0000-000000000002',
          targetType: 'artifact',
          text: 'Plain doc excerpt',
          meta: {
            artifactId: '00000000-0000-0000-0000-000000000002',
            path: 'docs/plain.md',
          },
        })}
      />,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Plain doc excerpt')).toBeTruthy();
    expect(screen.queryByText('markup')).toBeNull();
    expect(screen.queryByRole('button', { name: /Show all changes/ })).toBeNull();
  });
});
