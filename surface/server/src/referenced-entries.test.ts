import { describe, expect, it } from 'vitest';
import {
  appendReferencedEntriesAppendixText,
  composeReferencedEntriesAppendix,
  extractEntryLinks,
  type ReferencedEntryAppendixItem,
} from './referenced-entries.js';

describe('referenced entries appendix', () => {
  it('extracts relative entry links without a host', () => {
    expect(extractEntryLinks('Please inspect /e/evt_12 before continuing.')).toEqual([
      { originalLink: '/e/evt_12', handle: 'evt_12' },
    ]);
  });

  it('extracts relative and absolute entry links as canonical handles without a count cap', () => {
    const links = extractEntryLinks('See /e/evt_12 and https://atrium.test/e/rec_abc plus /e/not-a-handle!');
    expect(links).toEqual([
      { originalLink: '/e/evt_12', handle: 'evt_12' },
      { originalLink: 'https://atrium.test/e/rec_abc', handle: 'rec_abc' },
    ]);
  });

  it('returns byte-identical text when there are no appendix items', () => {
    const text = 'plain steer';
    expect(appendReferencedEntriesAppendixText(text, [])).toBe(text);
  });

  it('formats artifacts inside readable roots as local files', () => {
    const appendix = composeReferencedEntriesAppendix([
      {
        kind: 'local-file',
        originalLink: '/e/art_00000000-0000-0000-0000-000000000001',
        path: 'shared/channels/ch-1/docs/x.md',
      },
    ]);
    expect(appendix).toBe(
      '---\nReferenced entries:\n- /e/art_00000000-0000-0000-0000-000000000001 → local file: shared/channels/ch-1/docs/x.md',
    );
  });

  it('falls back to excerpts for artifacts outside readable roots and messages', () => {
    const appendix = composeReferencedEntriesAppendix([
      {
        kind: 'excerpt',
        originalLink: '/e/art_00000000-0000-0000-0000-000000000002',
        actorLabel: null,
        entryKind: 'artifact',
        text: 'outside root artifact text',
      },
      {
        kind: 'excerpt',
        originalLink: '/e/evt_9',
        actorLabel: 'Alice',
        entryKind: 'message',
        text: 'event text',
      },
    ]);
    expect(appendix).toContain('- /e/art_00000000-0000-0000-0000-000000000002 (artifact): "outside root artifact text"');
    expect(appendix).toContain('- /e/evt_9 (Alice, message): "event text"');
  });

  it('marks inaccessible entries explicitly', () => {
    expect(
      composeReferencedEntriesAppendix([
        { kind: 'inaccessible', originalLink: '/e/evt_404' },
        { kind: 'inaccessible', originalLink: '/e/art_00000000-0000-0000-0000-000000000003', workspace: true },
      ]),
    ).toBe(
      '---\nReferenced entries:\n- /e/evt_404: (not accessible)\n- /e/art_00000000-0000-0000-0000-000000000003: (not accessible in this workspace)',
    );
  });

  it('trims excerpts before omitting links to stay within the byte budget', () => {
    const items: ReferencedEntryAppendixItem[] = [
      {
        kind: 'excerpt',
        originalLink: '/e/evt_1',
        actorLabel: 'Alice',
        entryKind: 'message',
        text: 'x '.repeat(400),
      },
      {
        kind: 'local-file',
        originalLink: '/e/art_00000000-0000-0000-0000-000000000004',
        path: 'shared/channels/ch-1/docs/x.md',
      },
    ];
    const appendix = composeReferencedEntriesAppendix(items, 260)!;
    expect(Buffer.byteLength(appendix, 'utf8')).toBeLessThanOrEqual(260);
    expect(appendix).toContain('…');
    expect(appendix).toContain('local file: shared/channels/ch-1/docs/x.md');
  });

  it('emits an omitted line when links still do not fit', () => {
    const items = Array.from({ length: 8 }, (_, index): ReferencedEntryAppendixItem => ({
      kind: 'local-file',
      originalLink: `/e/art_00000000-0000-0000-0000-00000000000${index}`,
      path: `shared/channels/ch-1/very-long-directory-${index}/x.md`,
    }));
    const appendix = composeReferencedEntriesAppendix(items, 280)!;
    expect(Buffer.byteLength(appendix, 'utf8')).toBeLessThanOrEqual(280);
    expect(appendix).toMatch(/\(\d+ more omitted: \/e\/art_/);
  });
});
