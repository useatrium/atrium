// Composer grammar: "@agent <task>" spawns a session instead of posting a
// message. Optimistic card + POST /api/sessions reconciliation.

import type { AppAction } from '../appState';
import type { ChatMessage, UserRef } from '../state';
import { sessionsApi } from './api';
import { PENDING_SESSION_PREFIX, sessionFromWire, type Session } from './types';

export const AGENT_PREFIX = '@agent';

/** True while the composer text begins with "@agent" (drives the hint chip). */
export function looksLikeAgentCommand(text: string): boolean {
  return text.startsWith(AGENT_PREFIX);
}

/** Extract the task from "@agent <task>", or null if this is a plain message. */
export function parseAgentTask(text: string): string | null {
  if (!text.startsWith(`${AGENT_PREFIX} `)) return null;
  const task = text.slice(AGENT_PREFIX.length + 1).trim();
  return task.length > 0 ? task : null;
}

export interface SpawnContext {
  channelId: string;
  threadRootEventId?: number;
  me: UserRef;
  dispatch: (action: AppAction) => void;
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
  const { channelId, threadRootEventId, me, dispatch } = ctx;
  const tempId = `${PENDING_SESSION_PREFIX}${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const optimistic: Session = {
    id: tempId,
    workspaceId: '',
    channelId,
    threadRootEventId: threadRootEventId ?? null,
    title: task.slice(0, 80),
    status: 'spawning',
    harness: 'claude-code',
    spawnedBy: me.id,
    spawnerName: me.displayName,
    driverId: null,
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

  sessionsApi
    .create({ channelId, threadRootEventId, task })
    .then(({ session }) =>
      dispatch({ type: 'session-created', channelId, tempId, session: sessionFromWire(session) }),
    )
    .catch(() => dispatch({ type: 'session-spawn-failed', channelId, tempId }));
}
