import { describe, expect, it } from 'vitest';
import { sessionShareUrl } from './publicUrl';

describe('publicUrl', () => {
  it('builds session-first share links', () => {
    expect(sessionShareUrl('sess_abc')).toMatch(/\/s\/sess_abc$/);
  });
});
