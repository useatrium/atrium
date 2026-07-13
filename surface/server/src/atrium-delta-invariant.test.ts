import { describe, expect, it } from 'vitest';
import {
  renderArtifactsMarkdown,
  renderArtifactsMarkdownAppend,
  renderChangesMarkdown,
  renderChangesMarkdownAppend,
  renderEventsJsonl,
  renderFullMarkdown,
  renderFullMarkdownAppend,
  renderToolsMarkdown,
  renderToolsMarkdownAppend,
  renderTranscriptMarkdown,
  renderTranscriptMarkdownAppend,
} from './atrium-session-projection.js';
import type { SessionRecord } from './session-records.js';

/**
 * The invariant the whole delta protocol rests on.
 *
 * The daemon wrote `renderFull(prefix)` to disk on an earlier tick, and on this
 * tick it appends `renderAppend(suffix)` to those exact bytes without ever
 * re-reading them. So the file on disk is only correct if
 *
 *     renderFull(all) === renderFull(prefix) + renderAppend(suffix)
 *
 * byte for byte, at EVERY split point. A single stray or missing newline
 * between records makes every appended transcript in the fleet drift from what
 * the server would have rendered — silently, and permanently (nothing ever
 * rewrites the file while the epoch holds).
 *
 * The two sides of this protocol were implemented independently (TS renderers,
 * Rust appender) against a text contract, so nothing else checks that they
 * agree. This does.
 */

const KINDS = ['message', 'command', 'tool_call', 'reasoning', 'file_change', 'artifact', 'usage', 'status'] as const;

function record(seq: number): SessionRecord {
  const kind = KINDS[seq % KINDS.length]!;
  return {
    sessionId: 's1',
    eventId: 1000 + seq,
    seq,
    entryUid: `uid-${seq}`,
    kind,
    actor: seq % 3 === 0 ? 'user' : seq % 3 === 1 ? 'agent' : 'system',
    driver: seq % 2 === 0 ? 'claude' : 'codex',
    viewTier: seq % 2 === 0 ? 'lean' : 'full',
    text: `record ${seq}\nsecond line with *markdown* and a trailing space \n`,
    meta:
      kind === 'file_change'
        ? { path: `src/file-${seq}.ts`, changeKind: 'update' }
        : kind === 'tool_call'
          ? { toolName: 'Read', args: { path: `src/file-${seq}.ts` } }
          : kind === 'artifact'
            ? { path: `shared/art-${seq}.png`, mime: 'image/png' }
            : {},
    ts: new Date(Date.UTC(2026, 6, 13, 0, 0, seq % 60)),
  } as unknown as SessionRecord;
}

/**
 * `renders` mirrors the per-doc predicate in `sessionDocHadContent`, which is
 * what the route uses to decide whether an append is even offered. When the
 * prefix contains NO record this doc renders, the full renderer emits an
 * empty-state placeholder ("None." / "No transcript records.") — appending onto
 * that would leave the placeholder stranded above real content, so the server
 * answers `full` instead. The concatenation invariant therefore only has to
 * hold at splits the server can actually reach: those where the prefix already
 * rendered at least one record for that doc.
 */
const RENDERERS: Array<{
  doc: string;
  full: (r: SessionRecord[]) => string;
  append: (r: SessionRecord[]) => string;
  renders: (r: SessionRecord) => boolean;
}> = [
  {
    doc: 'transcript',
    full: renderTranscriptMarkdown as never,
    append: renderTranscriptMarkdownAppend,
    renders: (r) => r.viewTier === 'lean',
  },
  { doc: 'full', full: renderFullMarkdown, append: renderFullMarkdownAppend, renders: () => true },
  {
    doc: 'tools',
    full: renderToolsMarkdown,
    append: renderToolsMarkdownAppend,
    renders: (r) => r.kind === 'command' || r.kind === 'tool_call',
  },
  {
    doc: 'changes-doc',
    full: renderChangesMarkdown,
    append: renderChangesMarkdownAppend,
    renders: (r) => r.kind === 'file_change',
  },
  {
    doc: 'artifacts',
    full: renderArtifactsMarkdown,
    append: renderArtifactsMarkdownAppend,
    renders: (r) => r.kind === 'artifact',
  },
  { doc: 'events', full: renderEventsJsonl, append: renderEventsJsonl, renders: () => true },
];

describe('context-doc delta: full === prefix + append', () => {
  const all = Array.from({ length: 24 }, (_, i) => record(i + 1));

  for (const { doc, full, append, renders } of RENDERERS) {
    it(`${doc}: concatenation holds at every reachable split point`, () => {
      let checked = 0;
      for (let split = 1; split <= all.length; split += 1) {
        const prefix = all.slice(0, split);
        // the server only offers an append once the prefix has rendered content
        if (!prefix.some(renders)) continue;
        const suffix = all.slice(split);
        const stitched = full(prefix) + append(suffix);
        expect(stitched, `${doc} drifted at split=${split}`).toBe(full(all));
        checked += 1;
      }
      expect(checked, `${doc} exercised no reachable split`).toBeGreaterThan(0);
    });
  }

  it('the empty-prefix placeholder is NOT appendable (why sessionDocHadContent exists)', () => {
    // If this ever starts passing, the guard could be dropped. Until then it is
    // load-bearing: appending onto a placeholder strands "None." above real content.
    const stitched = renderToolsMarkdown([]) + renderToolsMarkdownAppend(all);
    expect(stitched).not.toBe(renderToolsMarkdown(all));
    expect(renderToolsMarkdown([])).toContain('None.');
  });

  it('an empty append is a no-op on the file', () => {
    for (const { doc, append } of RENDERERS) {
      expect(append([]), `${doc} emits bytes for an empty delta`).toBe('');
    }
  });
});
