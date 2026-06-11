import { describe, expect, it } from 'vitest';
import { looksLikeAgentCommand, parseAgentTask } from '../src/spawnTrigger';

describe('composer @agent grammar', () => {
  it('detects the exact web spawn trigger syntax', () => {
    expect(looksLikeAgentCommand('@agent')).toBe(true);
    expect(looksLikeAgentCommand('@agent fix tests')).toBe(true);
    expect(looksLikeAgentCommand(' @agent fix tests')).toBe(false);

    expect(parseAgentTask('@agent fix tests')).toBe('fix tests');
    expect(parseAgentTask('@agent   fix tests   ')).toBe('fix tests');
    expect(parseAgentTask('@agent')).toBeNull();
    expect(parseAgentTask('@agent   ')).toBeNull();
    expect(parseAgentTask('@agentic fix tests')).toBeNull();
  });
});
