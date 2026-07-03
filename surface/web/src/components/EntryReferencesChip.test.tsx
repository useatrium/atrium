// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENTRY_REFERENCES_CHUNK_SIZE,
  EntryReferencesChip,
  queryEntryReferencesForHandles,
  type EntryReferenceSummary,
} from './EntryReferencesChip';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    queryEntryReferences: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const summary: EntryReferenceSummary = {
  count: 2,
  latest: [
    {
      eventId: 11,
      handle: 'evt_11',
      channelId: 'ch_1',
      threadRootEventId: 7,
      actorLabel: 'Ava',
      excerpt: 'First discussion',
      ts: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      eventId: 12,
      handle: 'evt_12',
      channelId: 'ch_1',
      threadRootEventId: 7,
      actorLabel: null,
      excerpt: 'Second discussion',
      ts: new Date(Date.now() - 120_000).toISOString(),
    },
  ],
};

describe('EntryReferencesChip', () => {
  it('renders the count without hover gating', () => {
    render(<EntryReferencesChip summary={summary} />);
    expect(screen.getByRole('button', { name: '2 discussions' }).textContent).toContain('2');
  });

  it('navigates directly for one reference', () => {
    const onNavigate = vi.fn();
    render(
      <EntryReferencesChip
        summary={{ count: 1, latest: [summary.latest[0]!] }}
        onNavigate={onNavigate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '1 discussion' }));
    expect(onNavigate).toHaveBeenCalledWith('evt_11');
  });

  it('lists latest references for multiple discussions', () => {
    const onNavigate = vi.fn();
    render(<EntryReferencesChip summary={summary} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: '2 discussions' }));
    expect(screen.getByRole('dialog', { name: 'Entry discussions' })).not.toBeNull();
    expect(screen.getByText('Ava')).not.toBeNull();
    expect(screen.getByText('Someone')).not.toBeNull();
    expect(screen.getByText('First discussion')).not.toBeNull();
    fireEvent.click(screen.getByText('Second discussion'));
    expect(onNavigate).toHaveBeenCalledWith('evt_12');
  });

  it('queries references in chunks', async () => {
    const query = vi.mocked(
      (api as unknown as {
        queryEntryReferences: (handles: string[]) => Promise<{ references: Record<string, never> }>;
      }).queryEntryReferences,
    );
    query.mockResolvedValue({ references: {} });
    const handles = Array.from({ length: ENTRY_REFERENCES_CHUNK_SIZE + 1 }, (_, i) => `rec_${i}`);
    await queryEntryReferencesForHandles(handles);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toHaveLength(ENTRY_REFERENCES_CHUNK_SIZE);
    expect(query.mock.calls[1]![0]).toEqual([`rec_${ENTRY_REFERENCES_CHUNK_SIZE}`]);
  });
});
