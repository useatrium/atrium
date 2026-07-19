import type { Channel } from '@atrium/surface-client';
import { describe, expect, it, vi } from 'vitest';
import { buildAgentCommands } from './agentCommands';
import type { Session } from './types';

function channel(overrides: Partial<Channel> & Pick<Channel, 'id' | 'name'>): Channel {
  return {
    workspaceId: 'workspace-1',
    createdAt: '2026-07-18T12:00:00.000Z',
    archivedAt: null,
    pinned: false,
    kind: 'public',
    ...overrides,
  };
}

function session(overrides: Partial<Session> & Pick<Session, 'id' | 'title'>): Session {
  return {
    workspaceId: 'workspace-1',
    channelId: 'engineering',
    threadRootEventId: null,
    status: 'running',
    harness: 'codex',
    spawnedBy: 'user-1',
    driverId: null,
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    pendingQuestion: null,
    providerAuthRequired: null,
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-18T12:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 0,
    permalink: `/s/${overrides.id}`,
    ...overrides,
  };
}

describe('buildAgentCommands', () => {
  it('ranks needs-you agents before live work and recent terminal agents', () => {
    const commands = buildAgentCommands(
      {
        done: session({
          id: 'done',
          title: 'Finished migration',
          status: 'completed',
          completedAt: '2026-07-18T12:30:00.000Z',
        }),
        live: session({ id: 'live', title: 'Working migration', createdAt: '2026-07-18T12:20:00.000Z' }),
        needs: session({
          id: 'needs',
          title: 'Blocked migration',
          pendingQuestion: { questionId: 'question-1', questions: [], askedAt: '2026-07-18T12:10:00.000Z' },
        }),
      },
      [],
      'me',
      vi.fn(),
    );

    expect(commands.map((command) => command.id)).toEqual(['agent:needs', 'agent:live', 'agent:done']);
  });

  it('focuses the selected agent and resolves its channel name from the channel list', () => {
    const onFocusAgent = vi.fn();
    const [command] = buildAgentCommands(
      {
        'agent-7': session({ id: 'agent-7', title: 'Fix command center', channelId: 'channel-uuid' }),
      },
      [channel({ id: 'channel-uuid', name: 'product' })],
      'me',
      onFocusAgent,
    );

    expect(command).toMatchObject({
      id: 'agent:agent-7',
      label: 'Fix command center',
      subtitle: '#product · Working',
      group: 'Agents',
      keywords: ['Fix command center', 'product', 'codex', 'agent'],
    });
    command?.run();
    expect(onFocusAgent).toHaveBeenCalledOnce();
    expect(onFocusAgent).toHaveBeenCalledWith('agent-7');
  });

  it('labels DM/GDM channels with their member label instead of a #name', () => {
    const [command] = buildAgentCommands(
      { dm: session({ id: 'dm', title: 'Pairing', channelId: 'dm-uuid' }) },
      [
        channel({
          id: 'dm-uuid',
          name: '',
          kind: 'dm',
          members: [
            { id: 'me', handle: 'me', displayName: 'Me' },
            { id: 'them', handle: 'dana', displayName: 'Dana' },
          ],
        }),
      ],
      'me',
      vi.fn(),
    );

    expect(command?.subtitle).toBe('Dana · Working');
  });

  it('never leaks a raw channel id when the channel is unknown', () => {
    const [command] = buildAgentCommands(
      { orphan: session({ id: 'orphan', title: 'Orphan', channelId: '39797d43-ed0a-4eed-82b7-629bd5b6c25b' }) },
      [],
      'me',
      vi.fn(),
    );

    expect(command?.subtitle).toBe('#channel · Working');
    expect(command?.subtitle).not.toContain('39797d43');
  });

  it('falls back to a session snapshot channel name during hydration', () => {
    const snapshotSession = {
      ...session({ id: 'snap', title: 'Snapshot', channelId: 'not-hydrated' }),
      channelName: 'general',
    } as Session;
    const [command] = buildAgentCommands({ snap: snapshotSession }, [], 'me', vi.fn());

    expect(command?.subtitle).toBe('#general · Working');
  });
});
