import { describe, expect, it } from 'vitest';
import { extractEntryLinkHandles, isEntryHandle, partitionEntryLinks } from '../src/lib/entryLinks';

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

    expect(extractEntryLinkHandles(text, SERVER_URL)).toEqual([
      'evt_12',
      'art_123e4567-e89b-12d3-a456-426614174000',
    ]);
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
    });
  });

  it('validates shared handles plus mobile-local artifact handles', () => {
    expect(isEntryHandle('evt_1')).toBe(true);
    expect(isEntryHandle('rec_record_1')).toBe(true);
    expect(isEntryHandle('art_123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isEntryHandle('run_pending')).toBe(false);
  });
});
