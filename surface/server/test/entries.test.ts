// Handle codec round-trip + validation. Pure unit test — no DB.

import { describe, expect, it } from 'vitest';
import {
  decodeHandle,
  encodeEventHandle,
  encodeHandle,
  encodeRecordHandle,
  InvalidHandleError,
  tryDecodeHandle,
  type EntryHandle,
} from '../src/entries.js';

describe('entry handle codec', () => {
  it('round-trips event handles', () => {
    for (const id of [0, 1, 42, 9007199254740991]) {
      const handle = encodeEventHandle(id);
      expect(handle).toBe(`evt_${id}`);
      expect(decodeHandle(handle)).toEqual({ type: 'event', eventId: id });
    }
  });

  it('round-trips record handles', () => {
    for (const uid of ['abc123', 'tool_use_01ABC-xyz', 'a', 'A1_b2-C3']) {
      const handle = encodeRecordHandle(uid);
      expect(handle).toBe(`rec_${uid}`);
      expect(decodeHandle(handle)).toEqual({ type: 'record', entryUid: uid });
    }
  });

  it('encodeHandle is the inverse of decodeHandle', () => {
    const cases: EntryHandle[] = [
      { type: 'event', eventId: 7 },
      { type: 'record', entryUid: 'deadbeef' },
    ];
    for (const h of cases) {
      expect(decodeHandle(encodeHandle(h))).toEqual(h);
    }
  });

  it('rejects malformed event handles', () => {
    for (const bad of ['evt_', 'evt_abc', 'evt_-1', 'evt_1.5', 'evt_99999999999999999999']) {
      expect(() => decodeHandle(bad)).toThrow(InvalidHandleError);
    }
  });

  it('rejects malformed record handles', () => {
    for (const bad of ['rec_', 'rec_has space', 'rec_has/slash', 'rec_emoji😀']) {
      expect(() => decodeHandle(bad)).toThrow(InvalidHandleError);
    }
  });

  it('rejects reserved run_ handles distinctly', () => {
    expect(() => decodeHandle('run_abc')).toThrow(/reserved and not implemented/);
  });

  it('rejects unknown prefixes and empties', () => {
    for (const bad of ['', 'xyz_1', 'evt', '42', 'rec']) {
      expect(() => decodeHandle(bad)).toThrow(InvalidHandleError);
    }
  });

  it('encode guards reject bad input', () => {
    expect(() => encodeEventHandle(-1)).toThrow(InvalidHandleError);
    expect(() => encodeEventHandle(1.5)).toThrow(InvalidHandleError);
    expect(() => encodeRecordHandle('')).toThrow(InvalidHandleError);
    expect(() => encodeRecordHandle('has space')).toThrow(InvalidHandleError);
  });

  it('tryDecodeHandle returns null instead of throwing', () => {
    expect(tryDecodeHandle('nope')).toBeNull();
    expect(tryDecodeHandle('evt_5')).toEqual({ type: 'event', eventId: 5 });
  });
});
