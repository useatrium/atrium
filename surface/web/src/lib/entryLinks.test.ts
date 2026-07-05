import { describe, expect, it } from 'vitest';
import { extractEntryHandles, findEntryLinkCandidates, handleFromEntryUrl } from './entryLinks';

describe('entryLinks', () => {
  it('extracts entry handles from absolute links on any host', () => {
    expect(
      extractEntryHandles('see http://localhost:5177/e/art_00000000-0000-0000-0000-000000000001 here'),
    ).toEqual(['art_00000000-0000-0000-0000-000000000001']);
  });

  it('keeps validation and deduping behavior', () => {
    expect(
      extractEntryHandles(
        [
          'https://app.example/e/evt_42',
          '/e/rec_record-1',
          '/e/art_artifact_1',
          'https://elsewhere.example/e/evt_42',
          '/e/evt_nope',
          '/e/run_future',
        ].join(' '),
        'https://app.example',
      ),
    ).toEqual(['evt_42', 'rec_record-1', 'art_artifact_1']);
  });

  it('preserves trailing punctuation separately for renderers', () => {
    expect(findEntryLinkCandidates('check /e/evt_42.')[0]).toMatchObject({
      candidate: '/e/evt_42',
      trailing: '.',
      handle: 'evt_42',
      index: 6,
    });
  });

  it('resolves absolute entry links without enforcing origin equality', () => {
    expect(handleFromEntryUrl('https://elsewhere.example/e/evt_42', 'https://app.example')).toBe('evt_42');
  });
});
