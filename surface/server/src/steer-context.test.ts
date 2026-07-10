import { describe, expect, it } from 'vitest';
import {
  ATRIUM_CONTEXT_MARKER,
  buildSteerContextBlock,
  parseSteerContextBlock,
  stripSteerContextPrefix,
} from './steer-context.js';

describe('steer context block', () => {
  it('round-trips user provenance and suggestion attribution', () => {
    const block = buildSteerContextBlock({
      from: { name: 'Alice Basin', kind: 'human', seat: 'driver' },
      channel: 'design',
      sent: new Date('2026-07-08T14:32:05.000Z'),
      suggestion: {
        suggestedBy: { name: 'Bob Jones', kind: 'human' },
        acceptedBy: { name: 'Alice Basin', seat: 'driver' },
      },
    });

    expect(block).toBe(
        `${ATRIUM_CONTEXT_MARKER}\n` +
        'from: Alice Basin (human · driver)\n' +
        'channel: #design\n' +
        'sent: 2026-07-08T14:32:05Z\n' +
        'suggested by: Bob Jones (human) — accepted and sent by: Alice Basin (driver)',
    );
    expect(parseSteerContextBlock(block)).toEqual({
      name: 'Alice Basin',
      handle: null,
      kind: 'human',
      seat: 'driver',
      channel: 'design',
      sent: '2026-07-08T14:32:05Z',
      suggestedBy: { name: 'Bob Jones', handle: null, kind: 'human' },
      acceptedBy: { name: 'Alice Basin', handle: null, seat: 'driver' },
    });
  });


  it('round-trips handles as the canonical identifier when provided', () => {
    const block = buildSteerContextBlock({
      from: { name: 'Alice Basin', handle: 'alice', kind: 'human', seat: 'driver' },
      channel: 'design',
      sent: '2026-07-08T14:32:05Z',
      suggestion: {
        suggestedBy: { name: 'Bob Jones', handle: 'bob', kind: 'human' },
        acceptedBy: { name: 'Alice Basin', handle: 'alice', seat: 'driver' },
      },
    });

    expect(block).toContain('from: Alice Basin (@alice · human · driver)');
    expect(block).toContain(
      'suggested by: Bob Jones (@bob · human) — accepted and sent by: Alice Basin (@alice · driver)',
    );
    expect(parseSteerContextBlock(block)).toMatchObject({
      name: 'Alice Basin',
      handle: 'alice',
      kind: 'human',
      seat: 'driver',
      suggestedBy: { name: 'Bob Jones', handle: 'bob', kind: 'human' },
      acceptedBy: { name: 'Alice Basin', handle: 'alice', seat: 'driver' },
    });
    // Blocks written before handles shipped still parse (handle: null).
    expect(
      parseSteerContextBlock('[atrium context]\nfrom: Old Timer (human · driver)\nsent: 2026-07-01T00:00:00Z'),
    ).toMatchObject({ name: 'Old Timer', handle: null, kind: 'human' });
  });

  it('strips a merged context prefix without changing the user text remainder', () => {
    const block = buildSteerContextBlock({
      from: { name: 'Alice Basin', kind: 'human', seat: 'driver' },
      channel: '#design',
      sent: '2026-07-08T14:32:05Z',
    });

    expect(stripSteerContextPrefix(`${block}\n\n  keep my spacing  `)).toMatchObject({
      context: { name: 'Alice Basin', seat: 'driver' },
      text: '  keep my spacing  ',
    });
    expect(stripSteerContextPrefix(`<context>${block}</context>\n\nhello`)?.text).toBe('hello');
  });
});
