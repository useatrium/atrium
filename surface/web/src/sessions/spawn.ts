// Composer grammar helpers: "@agent <task>" routes to a queued session spawn
// instead of a plain message.

import type { AppAction } from '@atrium/surface-client';
import type { ChatMessage, SessionSpawnPayload, UserRef } from '@atrium/surface-client';
export { AGENT_PREFIX, looksLikeAgentCommand, parseAgentTask } from '@atrium/surface-client';
import { randomId, parseAgentTask } from '@atrium/surface-client';
import { PENDING_SESSION_PREFIX, type Session } from './types';

export interface SpawnContext {
  channelId: string;
  threadRootEventId?: number;
  me: UserRef;
  dispatch: (action: AppAction) => void;
  enqueueSpawn: (payload: SessionSpawnPayload) => void;
}

/**
 * If `text` is an @agent command, spawn a session (optimistic card now, POST
 * in the background) and return true. Returns false for plain messages.
 */
export function trySpawnFromComposer(text: string, ctx: SpawnContext): boolean {
  const task = parseAgentTask(text);
  if (task == null) return false;
  spawnSession(task, ctx);
  return true;
}

export function spawnSession(task: string, ctx: SpawnContext): void {
  const { channelId, threadRootEventId, me, dispatch, enqueueSpawn } = ctx;
  const tempId = `${PENDING_SESSION_PREFIX}${randomId()}`;
  const now = new Date().toISOString();

  const optimistic: Session = {
    id: tempId,
    workspaceId: '',
    channelId,
    threadRootEventId: threadRootEventId ?? null,
    title: task.slice(0, 80),
    status: 'spawning',
    harness: 'codex',
    spawnedBy: me.id,
    spawnerName: me.displayName,
    driverId: null,
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: now,
    completedAt: null,
    lastEventId: 0,
    permalink: '',
  };
  const row: ChatMessage = {
    id: null,
    clientMsgId: tempId,
    channelId,
    threadRootEventId: threadRootEventId ?? null,
    text: task,
    edited: false,
    author: me,
    createdAt: now,
    replyCount: 0,
    lastReplyId: 0,
    status: 'pending',
    sessionId: tempId,
  };
  dispatch({ type: 'session-spawn-pending', channelId, message: row, session: optimistic });
  enqueueSpawn({
    channelId,
    task,
    clientSpawnId: tempId,
    threadRootEventId,
    harness: 'codex',
    createdAt: now,
  });
}
