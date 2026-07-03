import { describe, expect, it } from 'vitest';
import { extractEntryLinkHandles, isEntryHandle } from '../src/lib/entryLinks';

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

  it('ignores foreign hosts and malformed handles', () => {
    const text = [
      'https://other.example.test/e/evt_12',
      '/e/evt_nope',
      '/e/rec_has/slash',
      '/e/art_not-a-uuid',
    ].join(' ');

    expect(extractEntryLinkHandles(text, SERVER_URL)).toEqual([]);
  });

  it('validates shared handles plus mobile-local artifact handles', () => {
    expect(isEntryHandle('evt_1')).toBe(true);
    expect(isEntryHandle('rec_record_1')).toBe(true);
    expect(isEntryHandle('art_123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isEntryHandle('run_pending')).toBe(false);
  });
});
