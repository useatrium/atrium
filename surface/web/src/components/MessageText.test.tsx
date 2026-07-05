// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEntryResolveCacheForTests, type ResolvedEntryQuote } from '../lib/entryLinks';
import { CompactMarkdownText, MessageText } from './MessageText';

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
    actorLabel: 'Ada',
    text: 'Inline quote body',
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
});

afterEach(() => {
  cleanup();
});

describe('MessageText entry links', () => {
  it('renders a compact entry ref as plain accent text, not the bordered pill', async () => {
    resolveEntryMock.mockResolvedValue(entry());

    render(<CompactMarkdownText text="see /e/evt_1" />);

    const link = await screen.findByRole('link', { name: /Ada:/ });
    expect(link.getAttribute('href')).toBe('/e/evt_1');
    // compact variant must NOT carry the pill chrome
    expect(link.className).not.toContain('border');
    expect(link.className).not.toContain('rounded');
    expect(link.className).toContain('text-accent-text');
  });

  it('renders inline entry refs as chips and preserves sentence punctuation', async () => {
    resolveEntryMock.mockResolvedValue(entry());

    const { container } = render(<MessageText text="Please review /e/evt_1." />);

    expect(screen.queryByText('/e/evt_1')).toBeNull();
    expect(await screen.findByText('Ada: “Inline quote body”')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Ada:/ }).getAttribute('href')).toBe('/e/evt_1');
    expect(container.textContent).toContain('Please review Ada: “Inline quote body”.');
  });

  it('drops standalone refs from the body and renders quote cards below', async () => {
    resolveEntryMock.mockResolvedValue(entry({ text: 'Standalone quote body' }));

    render(<MessageText text={'two tweaks before we ship this\n/e/evt_1'} />);

    expect(screen.getByText('two tweaks before we ship this')).toBeTruthy();
    expect(screen.queryByText('/e/evt_1')).toBeNull();
    expect(await screen.findByText('Standalone quote body')).toBeTruthy();
  });

  it('treats old absolute localhost refs as standalone quote cards', async () => {
    resolveEntryMock.mockResolvedValue(entry({ text: 'Recovered localhost ref' }));

    render(<MessageText text="http://localhost:5177/e/evt_1" />);

    expect(screen.queryByText('http://localhost:5177/e/evt_1')).toBeNull();
    expect(await screen.findByText('Recovered localhost ref')).toBeTruthy();
    expect(resolveEntryMock).toHaveBeenCalledWith('evt_1');
  });

  it('dedupes standalone handles and renders at most three quote cards per message', async () => {
    resolveEntryMock.mockImplementation((handle: string) =>
      Promise.resolve(
        entry({
          handle,
          text: `Quote for ${handle}`,
        }),
      ),
    );

    render(<MessageText text={'/e/evt_1\n/e/evt_1\n/e/evt_2\n/e/evt_3\n/e/evt_4'} />);

    await waitFor(() => expect(screen.getByText('Quote for evt_3')).toBeTruthy());

    expect(screen.getByText('Quote for evt_1')).toBeTruthy();
    expect(screen.getByText('Quote for evt_2')).toBeTruthy();
    expect(screen.queryByText('Quote for evt_4')).toBeNull();
    expect(resolveEntryMock).toHaveBeenCalledTimes(3);
    expect(resolveEntryMock).toHaveBeenNthCalledWith(1, 'evt_1');
    expect(resolveEntryMock).toHaveBeenNthCalledWith(2, 'evt_2');
    expect(resolveEntryMock).toHaveBeenNthCalledWith(3, 'evt_3');
  });

  it('does not restore a raw standalone ref when resolving fails', async () => {
    resolveEntryMock.mockRejectedValue(new Error('not found'));

    render(<MessageText text="/e/evt_404" />);

    await waitFor(() => expect(resolveEntryMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('/e/evt_404')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
