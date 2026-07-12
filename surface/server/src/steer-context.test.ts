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
      you: { name: 'Rex', sessionTitle: 'Fix the flaky e2e suite' },
      channel: 'design',
      channelId: 'd4dbf59b-f82d-4bcb-bca9-cba174205d6e',
      thread: '/e/evt_211',
      sent: new Date('2026-07-08T14:32:05.000Z'),
      suggestion: {
        suggestedBy: { name: 'Bob Jones', kind: 'human' },
        acceptedBy: { name: 'Alice Basin', seat: 'driver' },
      },
    });

    expect(block).toBe(
      `${ATRIUM_CONTEXT_MARKER}\n` +
        'from: Alice Basin (human · driver)\n' +
        'you: Rex — session "Fix the flaky e2e suite"\n' +
        'channel: #design (id: d4dbf59b-f82d-4bcb-bca9-cba174205d6e)\n' +
        'thread: /e/evt_211\n' +
        'sent: 2026-07-08T14:32:05Z\n' +
        'suggested by: Bob Jones (human) — accepted and sent by: Alice Basin (driver)',
    );
    expect(parseSteerContextBlock(block)).toEqual({
      name: 'Alice Basin',
      handle: null,
      kind: 'human',
      seat: 'driver',
      you: 'Rex — session "Fix the flaky e2e suite"',
      channel: 'design',
      channelId: 'd4dbf59b-f82d-4bcb-bca9-cba174205d6e',
      thread: '/e/evt_211',
      sent: '2026-07-08T14:32:05Z',
      suggestedBy: { name: 'Bob Jones', handle: null, kind: 'human' },
      acceptedBy: { name: 'Alice Basin', handle: null, seat: 'driver' },
    });
  });
  it('round-trips handles as the canonical identifier when provided', () => {
    const block = buildSteerContextBlock({
      from: { name: 'Alice Basin', handle: 'alice', kind: 'human', seat: 'driver' },
      you: { sessionTitle: 'Legacy agent' },
      channel: 'design',
      channelId: 'channel-id',
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
      you: { name: 'Rex', sessionTitle: `A title\n${'x'.repeat(90)}` },
      channel: '#design',
      channelId: 'channel-id',
      sent: '2026-07-08T14:32:05Z',
    });

    expect(stripSteerContextPrefix(`${block}\n\n  keep my spacing  `)).toMatchObject({
      context: { name: 'Alice Basin', seat: 'driver' },
      text: '  keep my spacing  ',
    });
    expect(stripSteerContextPrefix(`<context>${block}</context>\n\nhello`)?.text).toBe('hello');
    expect(block).toContain(`you: Rex — session "A title ${'x'.repeat(71)}…"`);
    expect(block).not.toContain('\nthread:');
  });

  it('parses old blocks and ignores unknown lines', () => {
    expect(
      parseSteerContextBlock(
        '[atrium context]\nfrom: Old Timer (human · driver)\nfuture: retained elsewhere\nchannel: #old\nsent: 2026-07-01T00:00:00Z',
      ),
    ).toMatchObject({
      name: 'Old Timer',
      you: null,
      channel: 'old',
      channelId: null,
      thread: null,
    });
  });
});
