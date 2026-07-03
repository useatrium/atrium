import { describe, expect, it } from 'vitest';
import { isTranscriptEntryHandle } from './SessionPane';

describe('SessionPane entry param handling', () => {
  it('only consumes transcript record handles', () => {
    expect(isTranscriptEntryHandle('rec_turn_1')).toBe(true);
    expect(isTranscriptEntryHandle('evt_12')).toBe(false);
    expect(isTranscriptEntryHandle('art_00000000-0000-0000-0000-000000000001')).toBe(false);
    expect(isTranscriptEntryHandle(null)).toBe(false);
  });
});
