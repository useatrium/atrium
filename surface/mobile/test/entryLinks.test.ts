import { describe, expect, it } from 'vitest';
import {
  extractEntryLinkHandles,
  isEntryHandle,
  partitionEntryLinks,
  unsuppressedEntryHandles,
  unsuppressedInternalLinks,
} from '../src/lib/entryLinks';

const SERVER_URL = 'https://atrium.example.test:3001';

describe('entry link extraction', () => {
  it('extracts relative and matching-host entry links, deduped and capped', () => {
    const text = [
      'See /e/evt_12.',
      'Again /e/evt_12',
      'Transcript https://atrium.example.test:3001/e/rec_alpha-123?from=chat',
      'Artifact /e/art_123e4567-e89b-12d3-a456-426614174000',
      'Ignored after cap /e/evt_99',
    ].join(' ');

    expect(extractEntryLinkHandles(text, SERVER_URL)).toEqual([
      'evt_12',
      'rec_alpha-123',
      'art_123e4567-e89b-12d3-a456-426614174000',
    ]);
  });

  it('accepts entry links from any host and ignores malformed handles', () => {
    const text = [
      'https://other.example.test/e/evt_12',
      'http://localhost:5177/e/art_123e4567-e89b-12d3-a456-426614174000',
      '/e/evt_nope',
      '/e/rec_has/slash',
      '/e/art_not-a-uuid',
    ].join(' ');

    expect(extractEntryLinkHandles(text, SERVER_URL)).toEqual(['evt_12', 'art_123e4567-e89b-12d3-a456-426614174000']);
  });

  it('partitions standalone entry links from inline body text', () => {
    const text = [
      'See /e/evt_12 inline.',
      '/e/evt_13.',
      '  https://foreign.example.test/e/rec_alpha-123?from=chat!  ',
      '/e/evt_13',
      'Keep this line.',
    ].join('\n');

    expect(partitionEntryLinks(text, SERVER_URL)).toEqual({
      bodyText: ['See /e/evt_12 inline.', 'Keep this line.'].join('\n'),
      standaloneHandles: ['evt_13', 'rec_alpha-123'],
      allHandles: ['evt_12', 'evt_13', 'rec_alpha-123'],
      internalLinks: [],
      externalUrls: [],
    });
  });

  it('intercepts session and channel URLs before external unfurl classification without stripping the body', () => {
    const text = [
      'Session https://prod.atrium.test/c/ch-1/s/s-1',
      'Members https://localhost:5173/c/ch-2/members?from=chat',
      'External https://example.com/story',
    ].join('\n');

    const partitioned = partitionEntryLinks(text, SERVER_URL);
    expect(partitioned.bodyText).toBe(text);
    expect(partitioned.internalLinks).toEqual([
      { kind: 'session', channelId: 'ch-1', sessionId: 's-1' },
      { kind: 'channel', channelId: 'ch-2', membersOpen: true },
    ]);
    expect(partitioned.externalUrls).toEqual(['https://example.com/story']);
    expect(unsuppressedInternalLinks(partitioned.internalLinks, ['session:s-1'])).toEqual([
      { kind: 'channel', channelId: 'ch-2', membersOpen: true },
    ]);
  });

  it('routes thread permalinks through the existing evt_ entry pipeline and keeps their URL visible', () => {
    const url = 'https://foreign.atrium.test/c/ch-1/t/42';
    const partitioned = partitionEntryLinks(url, SERVER_URL);

    expect(partitioned.bodyText).toBe(url);
    expect(partitioned.allHandles).toEqual(['evt_42']);
    expect(partitioned.internalLinks).toEqual([]);
    expect(partitioned.externalUrls).toEqual([]);
  });

  it('collects external URLs in first-seen order without double-matching entry links', () => {
    const text = [
      'Entry https://atrium.example.test/e/evt_12 and page https://example.com/story.',
      'Image https://cdn.example.com/photo.png then https://example.com/story',
      'Foreign entry https://other.example/e/rec_alpha-123 and https://example.net/docs?q=1.',
    ].join('\n');

    expect(partitionEntryLinks(text, SERVER_URL).externalUrls).toEqual([
      'https://example.com/story',
      'https://cdn.example.com/photo.png',
      'https://example.net/docs?q=1',
    ]);
  });

  it('collects inline and standalone handles in first-seen order and excludes suppressed previews', () => {
    const partitioned = partitionEntryLinks(
      ['Inline /e/evt_21 and /e/evt_22', '/e/evt_21', '/e/rec_alpha-123', 'Again /e/evt_22'].join('\n'),
      SERVER_URL,
    );

    expect(partitioned.allHandles).toEqual(['evt_21', 'evt_22', 'rec_alpha-123']);
    expect(unsuppressedEntryHandles(partitioned.allHandles, ['evt_22'])).toEqual(['evt_21', 'rec_alpha-123']);
  });

  it('validates shared handles plus mobile-local artifact handles', () => {
    expect(isEntryHandle('evt_1')).toBe(true);
    expect(isEntryHandle('rec_record_1')).toBe(true);
    expect(isEntryHandle('art_123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isEntryHandle('run_pending')).toBe(false);
  });
});
