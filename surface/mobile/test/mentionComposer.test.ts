import { matchMentionPrefix, suggestMentions, type MentionCandidate } from '@atrium/surface-client';
import { describe, expect, it } from 'vitest';
import {
  decodeEditingText,
  encodeMessageForSend,
  insertMentionCandidate,
  pruneWarnedMentions,
  updateMentionRangesForEdit,
} from '../src/lib/mentionComposer';

const USER_ID = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_ID = '123e4567-e89b-12d3-a456-426614174001';
const riley = { id: USER_ID, handle: 'riley', displayName: 'Riley Chen' };
const sam = { id: OTHER_ID, handle: 'sam', displayName: 'Sam Lee' };

describe('mobile mention composer contract', () => {
  it('matches the mention at the caret in the middle of a message', () => {
    const text = 'hello @ri tomorrow';
    expect(matchMentionPrefix(text.slice(0, 9))).toEqual({ start: 6, prefix: 'ri' });
  });

  it('uses shared suggestions without an @agent row and gates specials for DMs', () => {
    const channel = suggestMentions({ prefix: '', members: [riley], users: [riley, sam], includeSpecials: true });
    expect(channel.some((candidate) => candidate.kind === 'user' && candidate.user.handle === 'agent')).toBe(false);
    expect(channel.filter((candidate) => candidate.kind === 'special').map((candidate) => candidate.name)).toEqual([
      'channel',
      'here',
    ]);

    const dm = suggestMentions({ prefix: '', members: [riley], users: [riley, sam], includeSpecials: false });
    expect(dm.some((candidate) => candidate.kind === 'special')).toBe(false);
  });

  it('inserts at the caret and records a stable user range', () => {
    const candidate: MentionCandidate = { kind: 'user', user: riley, inChannel: true };
    expect(insertMentionCandidate('hello @ri tomorrow', [], 6, 9, 'riley', candidate)).toEqual({
      text: 'hello @riley  tomorrow',
      ranges: [{ start: 6, end: 12, userId: USER_ID }],
      caret: 13,
    });
  });

  it('shifts ranges after an edit and drops a range edited internally', () => {
    const ranges = [{ start: 6, end: 12, userId: USER_ID }];
    expect(updateMentionRangesForEdit('hello @riley', 'well hello @riley', ranges)).toEqual([
      { start: 11, end: 17, userId: USER_ID },
    ]);
    expect(updateMentionRangesForEdit('hello @riley', 'hello @rXiley', ranges)).toEqual([]);
  });

  it('drops a non-member warning once no range mentions that user', () => {
    const ranges = [{ start: 0, end: 6, userId: USER_ID }];
    expect(pruneWarnedMentions([riley, sam], ranges)).toEqual([riley]);
    expect(pruneWarnedMentions([riley], ranges)).toEqual([riley]);
    expect(pruneWarnedMentions([riley], [])).toEqual([]);
  });

  it('encodes sends and decodes edits back to display text and ranges', () => {
    const display = 'hello @riley and @channel';
    const ranges = [{ start: 6, end: 12, userId: USER_ID }];
    const wire = encodeMessageForSend(display, ranges);
    expect(wire).toBe(`hello <@${USER_ID}> and <!channel>`);
    expect(decodeEditingText(wire, (id) => (id === USER_ID ? riley : undefined))).toEqual({ text: display, ranges });
  });
});
