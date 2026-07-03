import { describe, expect, it } from 'vitest';
import { containsCriticMarkup, parseCriticMarkup, parseMarkupSteer } from '../src/criticmarkup';

const conflictSentence =
  "The save recorded a conflict against a newer version; please inspect the file's conflict state before producing the clean revision.";

describe('parseCriticMarkup', () => {
  it('parses every inline token kind', () => {
    expect(
      parseCriticMarkup(
        'Keep {--old--} and {++new++} with {~~before~>after~~}, {==this span==}{>>check it<<}, and {>>standalone<<}.',
      ),
    ).toEqual([
      {
        type: 'prose',
        segments: [
          { kind: 'text', text: 'Keep ' },
          { kind: 'del', text: 'old' },
          { kind: 'text', text: ' and ' },
          { kind: 'ins', text: 'new' },
          { kind: 'text', text: ' with ' },
          { kind: 'sub', del: 'before', ins: 'after' },
          { kind: 'text', text: ', ' },
          { kind: 'highlight', text: 'this span', comment: 'check it' },
          { kind: 'text', text: ', and ' },
          { kind: 'comment', comment: 'standalone' },
          { kind: 'text', text: '.' },
        ],
      },
    ]);
  });

  it('collapses adjacent deletion and insertion tokens into a substitution', () => {
    expect(parseCriticMarkup('{--old--}{++new++}')).toEqual([
      { type: 'prose', segments: [{ kind: 'sub', del: 'old', ins: 'new' }] },
    ]);
  });

  it('preserves multiline spans inside segment text', () => {
    expect(parseCriticMarkup('a {--one\ntwo--} b {++three\nfour++}')).toEqual([
      {
        type: 'prose',
        segments: [
          { kind: 'text', text: 'a ' },
          { kind: 'del', text: 'one\ntwo' },
          { kind: 'text', text: ' b ' },
          { kind: 'ins', text: 'three\nfour' },
        ],
      },
    ]);
  });

  it('handles multiple tokens on one line', () => {
    expect(parseCriticMarkup('{++a++} x {>>b<<} y {--c--}')).toEqual([
      {
        type: 'prose',
        segments: [
          { kind: 'ins', text: 'a' },
          { kind: 'text', text: ' x ' },
          { kind: 'comment', comment: 'b' },
          { kind: 'text', text: ' y ' },
          { kind: 'del', text: 'c' },
        ],
      },
    ]);
  });

  it('leaves bare highlights unstyled as literal text', () => {
    expect(parseCriticMarkup('Before {==plain==} after')).toEqual([
      { type: 'prose', segments: [{ kind: 'text', text: 'Before {==plain==} after' }] },
    ]);
  });

  it('does not scan CriticMarkup-looking text inside fenced code blocks', () => {
    expect(parseCriticMarkup('before\n```ts\nconst x = "{++no++}";\n```\nafter')).toEqual([
      { type: 'prose', segments: [{ kind: 'text', text: 'before\n' }] },
      { type: 'code', fence: '```ts', content: 'const x = "{++no++}";' },
      { type: 'prose', segments: [{ kind: 'text', text: 'after' }] },
    ]);
  });

  it('does not scan CriticMarkup-looking text inside inline code', () => {
    expect(parseCriticMarkup('Use `{++literal++}` then add {++real++}.')).toEqual([
      {
        type: 'prose',
        segments: [
          { kind: 'text', text: 'Use `{++literal++}` then add ' },
          { kind: 'ins', text: 'real' },
          { kind: 'text', text: '.' },
        ],
      },
    ]);
  });

  it('recognizes commented code block wrappers', () => {
    expect(parseCriticMarkup('{==```js\nconst x = 1;\n```==}{>>explain this<<}')).toEqual([
      { type: 'commented-code', fence: '```js', content: 'const x = 1;', comment: 'explain this' },
    ]);
  });

  it('handles escalated fences', () => {
    expect(parseCriticMarkup('````markdown\n```nested\nvalue\n```\n````')).toEqual([
      { type: 'code', fence: '````markdown', content: '```nested\nvalue\n```' },
    ]);
  });

  it('surfaces escaped CriticMarkup tokens as literal display text', () => {
    expect(parseCriticMarkup('\\{++literal++\\} and \\{>>comment<<\\}')).toEqual([
      { type: 'prose', segments: [{ kind: 'text', text: '{++literal++} and {>>comment<<}' }] },
    ]);
  });

  it('keeps unclosed tokens literal', () => {
    expect(parseCriticMarkup('start {--never closes and {++ok++}')).toEqual([
      {
        type: 'prose',
        segments: [
          { kind: 'text', text: 'start {--never closes and ' },
          { kind: 'ins', text: 'ok' },
        ],
      },
    ]);
  });

  it('emits hunk separators as separator blocks', () => {
    expect(parseCriticMarkup('a\n⋯\nb')).toEqual([
      { type: 'prose', segments: [{ kind: 'text', text: 'a\n' }] },
      { type: 'separator' },
      { type: 'prose', segments: [{ kind: 'text', text: 'b' }] },
    ]);
  });
});

describe('containsCriticMarkup', () => {
  it('detects unescaped CriticMarkup openers', () => {
    expect(containsCriticMarkup('a {--b--}')).toBe(true);
    expect(containsCriticMarkup('a {++b++}')).toBe(true);
    expect(containsCriticMarkup('a {~~b~>c~~}')).toBe(true);
    expect(containsCriticMarkup('a {==b==}{>>c<<}')).toBe(true);
    expect(containsCriticMarkup('a {>>b<<}')).toBe(true);
  });

  it('does not detect escaped-only or unrelated text', () => {
    expect(containsCriticMarkup('\\{++literal++\\} and \\{>>literal<<\\}')).toBe(false);
    expect(containsCriticMarkup('`{++literal++}`')).toBe(false);
    expect(containsCriticMarkup('CriticMarkup is a word in this sentence.')).toBe(false);
  });
});

describe('parseMarkupSteer', () => {
  it('parses response-intent steers with a small document', () => {
    const steer =
      'I marked up your message ("Draft answer", entry @agent:42) instead of replying in prose. The markup uses CriticMarkup: {--deletion--}, {++insertion++}, {~~old~>new~~}, {>>comment<<}, {==highlight==} (a highlight binds the following comment to that span). Treat edits as requested changes and comments as my reactions/questions. This is my response to what you wrote - not a request to edit a file.\n\n' +
      '```markdown\nHello {++there++}\n```';

    expect(parseMarkupSteer(steer)).toEqual({
      intent: 'response',
      title: 'Draft answer',
      path: null,
      sourceEntryHandle: '@agent:42',
      doc: 'Hello {++there++}',
      truncated: false,
      note: null,
      conflict: false,
    });
  });

  it('parses revise-intent steers with a note', () => {
    const steer =
      'I marked up `docs/plan.md` (my v7, on top of your v6) with changes and comments in CriticMarkup: {--deletion--}, {++insertion++}, {~~old~>new~~}, {>>comment<<}, {==highlight==}. The file in your workspace already has my markup. Please apply the edits, address the comments, and produce a clean next revision of `docs/plan.md` (remove all CriticMarkup syntax in your revision).\n\n' +
      '```markdown\n# Plan\n{--old--}{++new++}\n```\n\n' +
      'Note from me: Please keep the voice direct.';

    expect(parseMarkupSteer(steer)).toEqual({
      intent: 'revise',
      title: null,
      path: 'docs/plan.md',
      sourceEntryHandle: null,
      doc: '# Plan\n{--old--}{++new++}',
      truncated: false,
      note: 'Please keep the voice direct.',
      conflict: false,
    });
  });

  it('parses hunk mode with a full-document pointer', () => {
    const steer =
      'I marked up `docs/long.md` (my v9, on top of your v8) with changes and comments in CriticMarkup: {--deletion--}, {++insertion++}, {~~old~>new~~}, {>>comment<<}, {==highlight==}. The file in your workspace already has my markup. Please apply the edits, address the comments, and produce a clean next revision of `docs/long.md` (remove all CriticMarkup syntax in your revision).\n\n' +
      '````markdown\ncontext\n{++change++}\n⋯\nmore context\n````\n\n' +
      'Full document: docs/long.md (already synced into your workspace; my markup is v9, diff against v8).';

    expect(parseMarkupSteer(steer)).toMatchObject({
      intent: 'revise',
      path: 'docs/long.md',
      doc: 'context\n{++change++}\n⋯\nmore context',
      truncated: true,
      note: null,
      conflict: false,
    });
  });

  it('parses conflict steers', () => {
    const steer =
      'I marked up `src/app.ts` (my v4, on top of your v3) with changes and comments in CriticMarkup: {--deletion--}, {++insertion++}, {~~old~>new~~}, {>>comment<<}, {==highlight==}. The file in your workspace already has my markup. Please apply the edits, address the comments, and produce a clean next revision of `src/app.ts` (remove all CriticMarkup syntax in your revision).\n\n' +
      '```markdown\n{>>please review<<}\n```\n\n' +
      'Note from me: Watch the edge case.\n\n' +
      conflictSentence;

    expect(parseMarkupSteer(steer)).toEqual({
      intent: 'revise',
      title: null,
      path: 'src/app.ts',
      sourceEntryHandle: null,
      doc: '{>>please review<<}',
      truncated: false,
      note: 'Watch the edge case.',
      conflict: true,
    });
  });

  it('returns null for non-steer messages', () => {
    expect(parseMarkupSteer('This random message mentions CriticMarkup but is not a composed steer.')).toBeNull();
    expect(
      parseMarkupSteer(
        'I marked up `src/app.ts` with CriticMarkup.\n\n```markdown\n{++x++}\n```',
      ),
    ).toBeNull();
  });
});
