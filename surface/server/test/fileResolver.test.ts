import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBacking } from '../src/file-resolver.js';

const originalGitPrefix = process.env.GIT_PREFIX;

beforeEach(() => {
  delete process.env.GIT_PREFIX;
});

afterEach(() => {
  if (originalGitPrefix == null) {
    delete process.env.GIT_PREFIX;
  } else {
    process.env.GIT_PREFIX = originalGitPrefix;
  }
});

describe('resolveBacking', () => {
  it('routes default repo-prefixed paths to git', () => {
    expect(resolveBacking('repo/src/a.ts')).toEqual({ backing: 'git', relPath: 'src/a.ts' });
  });

  it('routes non-repo paths to the ledger', () => {
    expect(resolveBacking('proj-x/plan.md')).toEqual({ backing: 'ledger', relPath: 'proj-x/plan.md' });
  });

  it('honors a custom git prefix', () => {
    expect(resolveBacking('checkout/src/a.ts', { gitPrefix: 'checkout/' })).toEqual({
      backing: 'git',
      relPath: 'src/a.ts',
    });
    expect(resolveBacking('repo/src/a.ts', { gitPrefix: 'checkout/' })).toEqual({
      backing: 'ledger',
      relPath: 'repo/src/a.ts',
    });
  });
});
