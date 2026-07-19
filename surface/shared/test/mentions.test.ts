import { describe, expect, it } from 'vitest';
import {
  decodeWireToDisplay,
  encodeMentionsToWire,
  extractMentionTokens,
  matchMentionPrefix,
  mentionsUser,
  updateMentionRangesForEdit,
} from '../src/mentions';

const ALICE_ID = '123E4567-E89B-12D3-A456-426614174000';
const BOB_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('matchMentionPrefix', () => {
  it('returns a trailing mention prefix at valid left boundaries', () => {
    expect(matchMentionPrefix('hello @al')).toEqual({ start: 6, prefix: 'al' });
    expect(matchMentionPrefix('@')).toEqual({ start: 0, prefix: '' });
    expect(matchMentionPrefix('(@agent')).toEqual({ start: 1, prefix: 'agent' });
    expect(matchMentionPrefix('[@agent')).toEqual({ start: 1, prefix: 'agent' });
  });

  it('does not trigger inside words or email-like text', () => {
    expect(matchMentionPrefix('foo@')).toBeNull();
    expect(matchMentionPrefix('foo@bar')).toBeNull();
    expect(matchMentionPrefix('hello @al ')).toBeNull();
    expect(matchMentionPrefix('hello @al!')).toBeNull();
    expect(matchMentionPrefix('hello @a.b')).toBeNull();
    expect(matchMentionPrefix('hello')).toBeNull();
  });
});

describe('extractMentionTokens', () => {
  it('extracts, normalizes, and deduplicates tokens in first-appearance order', () => {
    expect(
      extractMentionTokens(`x <@${ALICE_ID}> <!HERE> <@${BOB_ID}> <@${ALICE_ID.toLowerCase()}> <!channel> <!here>`),
    ).toEqual({
      userIds: [ALICE_ID.toLowerCase(), BOB_ID],
      specials: ['here', 'channel'],
    });
  });

  it('ignores malformed wire tokens', () => {
    expect(extractMentionTokens('<@nope> <!everyone>')).toEqual({ userIds: [], specials: [] });
  });
});

describe('encodeMentionsToWire', () => {
  it('encodes sorted user ranges and word-boundary specials together', () => {
    const text = '@alice please ask @bob and @channel; (@here)';
    expect(
      encodeMentionsToWire(text, [
        { start: 18, end: 22, userId: BOB_ID },
        { start: 0, end: 6, userId: ALICE_ID.toLowerCase() },
      ]),
    ).toBe(`<@${ALICE_ID.toLowerCase()}> please ask <@${BOB_ID}> and <!channel>; (<!here>)`);
  });

  it('drops out-of-bounds, drifted, and overlapping ranges without throwing', () => {
    const text = '@alice and @bob';
    expect(
      encodeMentionsToWire(text, [
        { start: -1, end: 2, userId: 'negative' },
        { start: 0, end: 6, userId: ALICE_ID },
        { start: 2, end: 10, userId: 'overlap' },
        { start: 7, end: 10, userId: 'drifted' },
        { start: 11, end: 99, userId: 'past-end' },
        { start: 11, end: 15, userId: BOB_ID },
      ]),
    ).toBe(`<@${ALICE_ID}> and <@${BOB_ID}>`);
  });

  it('does not convert specials inside words or inserted user tokens', () => {
    const text = '@channeling@here foo@here @channel';
    expect(encodeMentionsToWire(text, [{ start: 0, end: 11, userId: 'channel' }])).toBe(
      '<@channel>@here foo@here <!channel>',
    );
  });
});

describe('decodeWireToDisplay', () => {
  it('decodes user and special tokens and round-trips resolved ids', () => {
    const wire = `Hi <@${ALICE_ID}> and <@${BOB_ID}> <!channel> <!here>`;
    const handles: Record<string, string> = { [ALICE_ID]: 'alice', [BOB_ID]: 'bob' };
    const decoded = decodeWireToDisplay(wire, (id) => handles[id] ?? null);

    expect(decoded).toEqual({
      text: 'Hi @alice and @bob @channel @here',
      ranges: [
        { start: 3, end: 9, userId: ALICE_ID },
        { start: 14, end: 18, userId: BOB_ID },
      ],
    });
    expect(encodeMentionsToWire(decoded.text, decoded.ranges)).toBe(wire);
  });

  it('uses an unknown fallback and records its range', () => {
    expect(decodeWireToDisplay(`<@${BOB_ID}>`, () => null)).toEqual({
      text: '@unknown',
      ranges: [{ start: 0, end: 8, userId: BOB_ID }],
    });
  });
});

describe('mentionsUser', () => {
  const me = { id: ALICE_ID.toLowerCase(), handle: 'gary' };

  it('matches the stable id token case-insensitively', () => {
    expect(mentionsUser(`hello <@${ALICE_ID}>`, me)).toBe(true);
    expect(mentionsUser(`hello <@${BOB_ID}>`, me)).toBe(false);
  });

  it('matches either special for every user', () => {
    expect(mentionsUser('hello <!here>', { id: null, handle: null })).toBe(true);
    expect(mentionsUser('hello <!channel>', { id: null, handle: null })).toBe(true);
  });

  it('matches legacy handles only at both word boundaries', () => {
    expect(mentionsUser('@gary, hi', me)).toBe(true);
    expect(mentionsUser('(@GARY)', me)).toBe(true);
    expect(mentionsUser('@gary_more', me)).toBe(false);
    expect(mentionsUser('foo@gary', me)).toBe(false);
    expect(mentionsUser('gary@example.com', { id: null, handle: 'example' })).toBe(false);
  });

  it('escapes regex metacharacters in legacy handles', () => {
    expect(mentionsUser('@g.ary!', { id: null, handle: 'g.ary' })).toBe(true);
    expect(mentionsUser('@gxary!', { id: null, handle: 'g.ary' })).toBe(false);
  });
});

describe('updateMentionRangesForEdit', () => {
  const range = { start: 6, end: 12, userId: ALICE_ID };

  it('returns the same ranges for a no-op edit', () => {
    const ranges = [range];
    expect(updateMentionRangesForEdit('hello @riley', 'hello @riley', ranges)).toBe(ranges);
  });

  it('shifts a range that sits after an insertion', () => {
    expect(updateMentionRangesForEdit('hello @riley', 'well hello @riley', [range])).toEqual([
      { start: 11, end: 17, userId: ALICE_ID },
    ]);
  });

  it('shifts a range left after a deletion before it', () => {
    expect(
      updateMentionRangesForEdit('hi hello @riley', 'hello @riley', [{ start: 9, end: 15, userId: ALICE_ID }]),
    ).toEqual([range]);
  });

  it('drops a range whose interior is edited', () => {
    expect(updateMentionRangesForEdit('hello @riley', 'hello @rXiley', [range])).toEqual([]);
  });

  it('drops a range a replacement overlaps and keeps an untouched earlier range', () => {
    const earlier = { start: 0, end: 5, userId: BOB_ID };
    expect(updateMentionRangesForEdit('@abcd @riley', '@abcd @riZ', [earlier, range])).toEqual([earlier]);
  });
});
