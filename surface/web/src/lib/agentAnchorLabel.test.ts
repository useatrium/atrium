import { encodeEventHandle } from '@atrium/surface-client/handle';
import { describe, expect, it } from 'vitest';
import { agentAnchorLabel } from './agentAnchorLabel';

describe('agentAnchorLabel', () => {
  it('combines the author with a collapsed, truncated message snippet', () => {
    expect(
      agentAnchorLabel({
        id: 42,
        author: { displayName: 'Ada Lovelace' },
        text: '  Investigate\n  why this particularly long flaky test keeps failing in CI  ',
      }),
    ).toBe('Ada Lovelace: Investigate why this particularly long…');
  });

  it('falls back to the event handle for an attachment-only message', () => {
    expect(agentAnchorLabel({ id: 42, author: { displayName: 'Ada Lovelace' }, text: ' \n ' })).toBe(
      `/e/${encodeEventHandle(42)}`,
    );
  });
});
