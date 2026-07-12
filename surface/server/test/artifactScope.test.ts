import { describe, expect, it } from 'vitest';
import { classifyScope, userCanReadScope, userCanReadSessionArtifactPath } from '../src/artifact-scope.js';
import { canonicalizeSessionArtifactPath, InvalidArtifactPathError } from '../src/artifact-path.js';

describe('artifact path scope classification', () => {
  it('classifies scratch paths as private', () => {
    expect(classifyScope('scratch/notes.md')).toBe('private');
    expect(userCanReadScope('private')).toBe(false);
  });

  it('classifies canonical shared paths as workspace', () => {
    expect(classifyScope('shared/global/report.md')).toBe('workspace');
    expect(classifyScope('shared/channels/channel-1/report.md')).toBe('workspace');
    expect(classifyScope('shared/report.md')).toBe('private');
    expect(userCanReadScope('workspace')).toBe(true);
  });

  it('allows session routes to read shared paths and their own scratch', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    expect(userCanReadSessionArtifactPath('shared/global/report.md', sessionId)).toBe(true);
    expect(userCanReadSessionArtifactPath(`scratch/${sessionId}/draft.md`, sessionId)).toBe(true);
    expect(userCanReadSessionArtifactPath('scratch/22222222-2222-4222-8222-222222222222/draft.md', sessionId)).toBe(
      false,
    );
    expect(userCanReadSessionArtifactPath('out/chart.png', sessionId)).toBe(false);
  });

  it('keeps topic scope readable if supplied by older callers', () => {
    expect(userCanReadScope('topic')).toBe(true);
  });

  it('defaults unknown paths to private', () => {
    expect(classifyScope('out/chart.png')).toBe('private');
    expect(classifyScope('proj-x/plan.md')).toBe('private');
    expect(classifyScope('topic/thread.md')).toBe('private');
    expect(classifyScope('scratch')).toBe('private');
  });
});

describe('artifact path canonicalization', () => {
  const ctx = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
  };

  it('maps bare home paths into the active channel scope', () => {
    expect(canonicalizeSessionArtifactPath('report.md', ctx)).toBe(`shared/channels/${ctx.channelId}/report.md`);
    expect(canonicalizeSessionArtifactPath('~/uploads/foo.txt', ctx)).toBe(
      `shared/channels/${ctx.channelId}/uploads/foo.txt`,
    );
  });

  it('keeps explicit shared and own scratch paths idempotent', () => {
    const shared = `shared/channels/${ctx.channelId}/report.md`;
    const scratch = `scratch/${ctx.sessionId}/draft.md`;
    expect(canonicalizeSessionArtifactPath(shared, ctx)).toBe(shared);
    expect(canonicalizeSessionArtifactPath(scratch, ctx)).toBe(scratch);
    expect(canonicalizeSessionArtifactPath(canonicalizeSessionArtifactPath(shared, ctx), ctx)).toBe(shared);
  });

  it('allows explicit readable channel paths when supplied by the resolver', () => {
    const otherChannelId = '33333333-3333-4333-8333-333333333333';
    const path = `shared/channels/${otherChannelId}/report.md`;
    expect(canonicalizeSessionArtifactPath(path, { ...ctx, readableChannelIds: [ctx.channelId, otherChannelId] })).toBe(
      path,
    );
  });

  it('maps scratch aliases into the current session scratch', () => {
    expect(canonicalizeSessionArtifactPath('scratch/draft.md', ctx)).toBe(`scratch/${ctx.sessionId}/draft.md`);
    expect(canonicalizeSessionArtifactPath('~/scratch/draft.md', ctx)).toBe(`scratch/${ctx.sessionId}/draft.md`);
  });

  it('rejects reserved roots and ad-hoc shared roots', () => {
    expect(() => canonicalizeSessionArtifactPath('repo/src/app.ts', ctx)).toThrow(InvalidArtifactPathError);
    expect(() => canonicalizeSessionArtifactPath('.codex/auth.json', ctx)).toThrow(InvalidArtifactPathError);
    expect(() => canonicalizeSessionArtifactPath('shared/report.md', ctx)).toThrow(InvalidArtifactPathError);
    // Writes follow reads: a foreign channel UUID is addressable at the path
    // layer; authorization (403) happens at the route scope checks instead.
    expect(canonicalizeSessionArtifactPath('shared/channels/33333333-3333-4333-8333-333333333333/report.md', ctx)).toBe(
      'shared/channels/33333333-3333-4333-8333-333333333333/report.md',
    );
    expect(() => canonicalizeSessionArtifactPath('shared/channels/not-a-uuid/report.md', ctx)).toThrow(
      InvalidArtifactPathError,
    );
    expect(() => canonicalizeSessionArtifactPath('shared/projects/proj-1/report.md', ctx)).toThrow(
      InvalidArtifactPathError,
    );
    expect(() => canonicalizeSessionArtifactPath('scratch/33333333-3333-4333-8333-333333333333/file.md', ctx)).toThrow(
      InvalidArtifactPathError,
    );
  });
});
