// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryQuoteCard } from './EntryQuoteCard';
import { MessageText } from './MessageText';
import {
  clearEntryResolveCacheForTests,
  extractEntryHandles,
  type ResolvedEntryQuote,
} from '../lib/entryLinks';

const resolveEntryMock = vi.hoisted(() => vi.fn());

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
    text: 'This is the quoted entry text with useful context.',
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
});

afterEach(() => cleanup());

describe('entry links', () => {
  it('detects current-origin absolute links and relative links while ignoring invalid and cross-origin links', () => {
    expect(
      extractEntryHandles(
        [
          'https://app.example/e/evt_42',
          '/e/rec_record-1',
          '/e/art_artifact_1',
          'https://elsewhere.example/e/evt_99',
          '/e/evt_nope',
          '/e/run_future',
        ].join(' '),
        'https://app.example',
      ),
    ).toEqual(['evt_42', 'rec_record-1', 'art_artifact_1']);
  });

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
    expect(screen.getByRole('link').getAttribute('href')).toBe('/e/evt_1');
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

  it('caches resolved entries across renders', async () => {
    resolveEntryMock.mockResolvedValue(entry());

    render(<MessageText text="Raw link stays visible: /e/evt_1" />);
    expect(screen.getByText(/Raw link stays visible: \/e\/evt_1/)).toBeTruthy();
    expect(screen.queryByText('This is the quoted entry text with useful context.')).toBeNull();
    expect(await screen.findByText('This is the quoted entry text with useful context.')).toBeTruthy();
    expect(resolveEntryMock).toHaveBeenCalledTimes(1);

    cleanup();
    render(<MessageText text="Same entry again: /e/evt_1" />);
    expect(await screen.findByText('This is the quoted entry text with useful context.')).toBeTruthy();
    expect(resolveEntryMock).toHaveBeenCalledTimes(1);
  });

  it('caches failed resolves as misses', async () => {
    resolveEntryMock.mockRejectedValue(new Error('not found'));

    render(<MessageText text="/e/evt_404" />);
    await waitFor(() => expect(resolveEntryMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('link')).toBeNull();

    cleanup();
    render(<MessageText text="/e/evt_404" />);
    await waitFor(() => expect(screen.getByText('/e/evt_404')).toBeTruthy());
    expect(resolveEntryMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes handles and renders at most three quote cards per message', async () => {
    resolveEntryMock.mockImplementation((handle: string) =>
      Promise.resolve(
        entry({
          handle,
          text: `Quote for ${handle}`,
        }),
      ),
    );

    render(<MessageText text="/e/evt_1 /e/evt_1 /e/evt_2 /e/evt_3 /e/evt_4" />);

    await waitFor(() => expect(screen.getByText('Quote for evt_3')).toBeTruthy());

    expect(screen.getByText('Quote for evt_1')).toBeTruthy();
    expect(screen.getByText('Quote for evt_2')).toBeTruthy();
    expect(screen.queryByText('Quote for evt_4')).toBeNull();
    expect(resolveEntryMock).toHaveBeenCalledTimes(3);
    expect(resolveEntryMock).toHaveBeenNthCalledWith(1, 'evt_1');
    expect(resolveEntryMock).toHaveBeenNthCalledWith(2, 'evt_2');
    expect(resolveEntryMock).toHaveBeenNthCalledWith(3, 'evt_3');
  });
});
