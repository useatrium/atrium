import { describe, expect, it } from 'vitest';
import { classifyScope, userCanReadScope } from '../src/artifact-scope.js';

describe('artifact path scope classification', () => {
  it('classifies scratch paths as private', () => {
    expect(classifyScope('scratch/notes.md')).toBe('private');
    expect(userCanReadScope('private')).toBe(false);
  });

  it('classifies shared paths as workspace', () => {
    expect(classifyScope('shared/report.md')).toBe('workspace');
    expect(userCanReadScope('workspace')).toBe(true);
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
