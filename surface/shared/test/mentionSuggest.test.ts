import { describe, expect, it } from 'vitest';
import { suggestMentions } from '../src/mentionSuggest';
import type { UserRef } from '../src/timeline';

const user = (id: string, handle: string, displayName: string): UserRef => ({ id, handle, displayName });
const alice = user('1', 'alice', 'Alice Able');
const albert = user('2', 'albert', 'Bert Jones');
const sally = user('3', 'sally', 'Sally Alice');
const malcolm = user('4', 'malcolm', 'Mal Reynolds');
const zed = user('5', 'zed', 'Alice Zebra');

describe('suggestMentions', () => {
  it('ranks members ahead of non-members, then match tiers and handles', () => {
    expect(
      suggestMentions({ prefix: 'al', members: [malcolm, zed], users: [alice, albert, sally, malcolm, zed] }),
    ).toEqual([
      { kind: 'user', user: zed, inChannel: true },
      { kind: 'user', user: malcolm, inChannel: true },
      { kind: 'user', user: albert, inChannel: false },
      { kind: 'user', user: alice, inChannel: false },
      { kind: 'user', user: sally, inChannel: false },
    ]);
  });

  it('puts exact handles over handle prefixes within a membership group', () => {
    expect(suggestMentions({ prefix: 'alice', users: [sally, alice, zed] })).toEqual([
      { kind: 'user', user: alice, inChannel: false },
      { kind: 'user', user: sally, inChannel: false },
      { kind: 'user', user: zed, inChannel: false },
    ]);
  });

  it('deduplicates by id, prefers the member copy, and handles an unloaded roster', () => {
    const memberAlice = { ...alice, displayName: 'Member Alice' };
    expect(suggestMentions({ prefix: '', members: [memberAlice], users: [alice, albert] })).toEqual([
      { kind: 'user', user: memberAlice, inChannel: true },
      { kind: 'user', user: albert, inChannel: false },
    ]);
    expect(suggestMentions({ prefix: '', members: null, users: [alice] })).toEqual([
      { kind: 'user', user: alice, inChannel: false },
    ]);
  });

  it('sorts empty-prefix users by membership and handle and applies the user-only limit', () => {
    expect(suggestMentions({ prefix: '', members: [zed, alice], users: [malcolm, zed, alice], limit: 2 })).toEqual([
      { kind: 'user', user: alice, inChannel: true },
      { kind: 'user', user: zed, inChannel: true },
    ]);
  });

  it('appends matching specials after user rows and omits them when disabled', () => {
    expect(suggestMentions({ prefix: '', users: [alice], includeSpecials: true, limit: 1 })).toEqual([
      { kind: 'user', user: alice, inChannel: false },
      { kind: 'special', name: 'channel', description: 'Notify everyone in this channel' },
      { kind: 'special', name: 'here', description: 'Notify channel members who are online' },
    ]);
    expect(suggestMentions({ prefix: 'CH', users: [alice], includeSpecials: true })).toEqual([
      { kind: 'special', name: 'channel', description: 'Notify everyone in this channel' },
    ]);
    expect(suggestMentions({ prefix: 'he', includeSpecials: false })).toEqual([]);
  });
});
