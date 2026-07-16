import type { AttachmentRef } from './opQueue';
import type { AttachmentMeta } from './timeline';

export type ComposerAudience = 'people' | 'agent';

export type AgentComposerRequest =
  | {
      target: 'spawn-channel';
      anchorEventId?: number;
      effort?: string;
    }
  | {
      target: 'spawn-thread';
      threadRootEventId: number;
      anchorEventId?: number;
      effort?: string;
    }
  | {
      target: 'steer';
      sessionId: string;
      threadRootEventId?: number;
      anchorEventId?: number;
      effort?: string;
    }
  | {
      target: 'suggest';
      sessionId: string;
      threadRootEventId?: number;
      anchorEventId?: number;
    };

export type ComposerSubmission = {
  text: string;
  attachments?: AttachmentMeta[];
  attachmentRefs?: AttachmentRef[];
};

export type ComposerDestination =
  | {
      audience: 'people';
      scope: 'channel' | 'thread';
      label: string;
      description: string;
      sendLabel: string;
    }
  | {
      audience: 'agent';
      request: AgentComposerRequest;
      label: string;
      description: string;
      sendLabel: 'Start' | 'Steer' | 'Suggest';
      acceptsAttachments: true;
      acceptsVoice: false;
    };

export function audienceFromAgentIntent(agentIntent: boolean | undefined): ComposerAudience {
  return agentIntent === true ? 'agent' : 'people';
}

export function agentIntentFromAudience(audience: ComposerAudience): boolean {
  return audience === 'agent';
}

export function audienceAfterAgentSend(request: AgentComposerRequest): ComposerAudience {
  return request.target === 'steer' || request.target === 'suggest' ? 'agent' : 'people';
}

export function peopleDestination(
  scope: 'channel' | 'thread',
  label: string,
): Extract<ComposerDestination, { audience: 'people' }> {
  return {
    audience: 'people',
    scope,
    label,
    description:
      scope === 'thread'
        ? 'Posts to the thread without prompting the agent'
        : 'Posts to the conversation without prompting the agent',
    sendLabel: scope === 'thread' ? 'Reply' : 'Message',
  };
}

export function agentDestination(
  request: AgentComposerRequest,
  label: string,
): Extract<ComposerDestination, { audience: 'agent' }> {
  const action = request.target === 'steer' ? 'Steer' : request.target === 'suggest' ? 'Suggest' : 'Start';
  return {
    audience: 'agent',
    request,
    label,
    description:
      request.target === 'steer'
        ? `Prompts ${label}`
        : request.target === 'suggest'
          ? `Suggests a prompt for ${label}`
          : `Starts ${label}`,
    sendLabel: action,
    acceptsAttachments: true,
    acceptsVoice: false,
  };
}
