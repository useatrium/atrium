import { describe, expect, it } from 'vitest';
import {
  renderChannelChatMarkdown,
  renderChannelMarkdown,
  type ChannelChatMessage,
  type ChannelDocInfo,
} from './atrium-channel-projection.js';

function msg(partial: Partial<ChannelChatMessage> & Pick<ChannelChatMessage, 'id' | 'text'>): ChannelChatMessage {
  return {
    handle: `evt_${partial.id}`,
    authorName: 'Alice Basin',
    authorHandle: 'alice',
    createdAt: new Date('2026-07-07T14:32:00.000Z'),
    threadRootEventId: null,
    ...partial,
  };
}

describe('atrium channel projection', () => {
  it('renders channel metadata with member handles and session driver', () => {
    const info: ChannelDocInfo = {
      id: 'chan-1',
      name: 'general',
      kind: 'public',
      active: true,
      lastEventId: 42,
      driver: { id: 'u1', displayName: 'Alice Basin', handle: 'alice' },
      members: [
        { id: 'u1', displayName: 'Alice Basin', handle: 'alice' },
        { id: 'u2', displayName: 'Bob Jones', handle: 'bob' },
      ],
    };

    const md = renderChannelMarkdown(info);

    expect(md).toContain('# general');
    expect(md).toContain('- id: chan-1');
    expect(md).toContain('- kind: public');
    expect(md).toContain('- active for this session: yes');
    expect(md).toContain('- this session driver: Alice Basin (@alice)');
    expect(md).toContain('- Bob Jones (@bob)');
  });

  it('renders anchors and thread replies under their root', () => {
    const md = renderChannelChatMarkdown([
      msg({ id: 1, text: "Let's use cursor-based pagination..." }),
      msg({
        id: 2,
        authorName: 'Bob Jones',
        authorHandle: 'bob',
        text: 'Agreed, but cap page size.',
        createdAt: new Date('2026-07-07T14:35:00.000Z'),
        threadRootEventId: 1,
      }),
    ]);

    expect(md).toContain(
      "**Alice Basin** (@alice) · 2026-07-07 14:32 ⟨/e/evt_1⟩\nLet's use cursor-based pagination...",
    );
    expect(md).toContain('  ↳ **Bob Jones** (@bob) · 14:35 ⟨/e/evt_2⟩\n  Agreed, but cap page size.');
  });

  it('renders a persisted agent reply under its session card root', () => {
    const md = renderChannelChatMarkdown([
      msg({ id: 10, text: 'Investigate the cache invalidation bug.' }),
      msg({
        id: 11,
        authorName: 'Investigate the cache invalidation bug',
        authorHandle: null,
        text: 'I found the stale key path.',
        createdAt: new Date('2026-07-07T14:36:00.000Z'),
        threadRootEventId: 10,
        isAgent: true,
      }),
    ]);

    expect(md).toContain(
      '  ↳ **Investigate the cache invalidation bug (agent)** · 14:36 ⟨/e/evt_11⟩\n  I found the stale key path.',
    );
  });

  it('tails oversized chat output with an elision note', () => {
    const md = renderChannelChatMarkdown(
      [
        msg({ id: 1, text: 'older message that should be omitted' }),
        msg({ id: 2, text: 'newer message that should remain' }),
      ],
      120,
    );

    expect(md).toContain('...older messages elided (1)...');
    expect(md).not.toContain('older message that should be omitted');
    expect(md).toContain('newer message that should remain');
  });
});
