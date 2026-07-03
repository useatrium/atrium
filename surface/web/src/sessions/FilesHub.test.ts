import { describe, expect, it } from 'vitest';
import { fileMatchesSessionScope } from './FilesHub';

describe('fileMatchesSessionScope', () => {
  it('matches exact paths', () => {
    expect(fileMatchesSessionScope('src/app.ts', ['src/app.ts'])).toBe(true);
  });

  it('matches descendants of touched directories', () => {
    expect(fileMatchesSessionScope('src/components/Button.tsx', ['src/components'])).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(fileMatchesSessionScope('src/components/Button.tsx', ['docs/components'])).toBe(false);
  });

  it('normalizes ledger prefixes, workspace absolute paths, and backslashes', () => {
    expect(
      fileMatchesSessionScope('shared/channels/22222222-2222-4222-8222-222222222222/src/app.ts', [
        '/home/agent/workspace/src/app.ts',
      ]),
    ).toBe(true);
    expect(
      fileMatchesSessionScope('scratch/11111111-1111-4111-8111-111111111111/out/chart.png', [
        'out\\chart.png',
      ]),
    ).toBe(true);
  });
});
