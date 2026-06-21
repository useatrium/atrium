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

  it('classifies proj-x paths as topic', () => {
    expect(classifyScope('proj-x/plan.md')).toBe('topic');
    expect(userCanReadScope('topic')).toBe(true);
  });

  it('classifies topic paths as topic', () => {
    expect(classifyScope('topic/thread.md')).toBe('topic');
  });

  it('defaults unknown paths to workspace', () => {
    expect(classifyScope('out/chart.png')).toBe('workspace');
    expect(classifyScope('scratch')).toBe('workspace');
  });
});
