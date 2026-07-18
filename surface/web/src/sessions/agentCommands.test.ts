import { describe, expect, it, vi } from 'vitest';
import { buildAgentCommands } from './agentCommands';
import type { Session } from './types';

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
      vi.fn(),
    );

    expect(commands.map((command) => command.id)).toEqual(['agent:needs', 'agent:live', 'agent:done']);
  });

  it('focuses the selected agent and describes its channel and glance', () => {
    const onFocusAgent = vi.fn();
    const [command] = buildAgentCommands(
      {
        'agent-7': session({ id: 'agent-7', title: 'Fix command center', channelId: 'product' }),
      },
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
});
