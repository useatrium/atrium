import { describe, expect, it } from 'vitest';
import {
  agentDestination,
  agentIntentFromAudience,
  audienceAfterAgentSend,
  audienceFromAgentIntent,
  peopleDestination,
} from '../src/composerRouting';

describe('composer routing', () => {
  it('keeps the existing boolean draft wire format compatible', () => {
    expect(audienceFromAgentIntent(undefined)).toBe('people');
    expect(audienceFromAgentIntent(false)).toBe('people');
    expect(audienceFromAgentIntent(true)).toBe('agent');
    expect(agentIntentFromAudience('people')).toBe(false);
    expect(agentIntentFromAudience('agent')).toBe(true);
  });

  it('keeps steer and suggest sticky but resets after spawning', () => {
    expect(audienceAfterAgentSend({ target: 'spawn-channel' })).toBe('people');
    expect(audienceAfterAgentSend({ target: 'spawn-thread', threadRootEventId: 12 })).toBe('people');
    expect(audienceAfterAgentSend({ target: 'steer', sessionId: 's-1' })).toBe('agent');
    expect(audienceAfterAgentSend({ target: 'suggest', sessionId: 's-1' })).toBe('agent');
  });

  it('derives stable people and agent copy from typed destinations', () => {
    expect(peopleDestination('thread', 'this thread')).toMatchObject({
      audience: 'people',
      sendLabel: 'Reply',
      description: 'Posts to the thread without prompting the agent',
    });
    expect(agentDestination({ target: 'steer', sessionId: 's-1' }, 'Fix tests')).toMatchObject({
      audience: 'agent',
      sendLabel: 'Steer',
      acceptsAttachments: true,
      acceptsVoice: false,
    });
  });
});
