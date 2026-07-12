import {
  ApiError,
  createDefaultOpRegistry,
  type OpQueueLockProvider,
  type OpRegistry,
  type OpType,
} from '@atrium/surface-client';

export const QUEUE_NUDGE_KEY = 'atrium:queue-nudge';

export function createQueueLockProvider(): OpQueueLockProvider | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const locks = (
    navigator as Navigator & {
      locks?: {
        request<T>(name: string, callback: () => T | PromiseLike<T>): Promise<T>;
      };
    }
  ).locks;
  if (!locks) return undefined;
  return {
    request: <T,>(name: string, callback: () => Promise<T>) => locks.request<T>(name, callback),
  };
}

export function broadcastQueueNudge(): void {
  try {
    window.localStorage.setItem(QUEUE_NUDGE_KEY, `${Date.now()}:${Math.random()}`);
  } catch {
    // Best-effort multi-tab wake-up only.
  }
}

export function queuedFailureMessage(opType: OpType, err?: unknown): string {
  if (opType === 'session.spawn') {
    const githubMessage = githubSpawnFailureMessage(err);
    if (githubMessage) return githubMessage;
  }
  switch (opType) {
    case 'msg.send':
      return "Couldn't send the message.";
    case 'upload':
      return "Couldn't upload the file.";
    case 'msg.edit':
      return "Couldn't save the edit.";
    case 'msg.delete':
      return "Couldn't delete the message.";
    case 'reaction.set':
      return "Couldn't update the reaction.";
    case 'read.mark':
      return "Couldn't mark the channel read.";
    case 'mute.set':
      return "Couldn't update the mute setting.";
    case 'session.spawn':
      return "Couldn't start the agent.";
    case 'session.answer':
      return "Couldn't submit the answer.";
    case 'session.steer':
      return "Couldn't send the agent message.";
    case 'session.cancel':
      return "Couldn't cancel the agent.";
    case 'session.stop_turn':
      return "Couldn't stop the turn.";
    case 'prefs.set':
      return "Couldn't sync settings.";
    case 'draft.set':
      return "Couldn't sync the draft.";
    case 'channel.join':
      return "Couldn't add the person.";
    case 'channel.leave':
      return "Couldn't leave the channel.";
    case 'channel.archive':
    case 'session.archive':
      return "Couldn't update the archive setting.";
    case 'channel.pin':
    case 'session.pin':
      return "Couldn't update the pin setting.";
  }
}

function githubSpawnFailureMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case 'github_connection_required':
      return 'Connect GitHub before starting an agent with private repositories.';
    case 'github_repo_access_unverified':
      return 'Reconnect GitHub before starting an agent with private repositories.';
    case 'github_repo_inaccessible':
      return err.message || 'Connected GitHub credentials cannot access one or more private repositories.';
    case 'github_repo_validation_unconfigured':
      return 'GitHub App repository validation is not configured.';
    case 'github_repo_validation_failed':
      return 'Could not validate GitHub repository access. Try again or reconnect GitHub.';
    case 'github_identity_unavailable':
      return err.message || 'Connect GitHub with the selected identity before starting this session.';
    default:
      return null;
  }
}

export function createChatOpRegistry(): OpRegistry {
  // Web currently needs no op overrides; shared handles msg.send payload forwarding.
  return createDefaultOpRegistry();
}
