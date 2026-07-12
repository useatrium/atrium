import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveSessionCapabilitySnapshot } from '../src/session-capabilities.js';

function bytes(lines: Record<string, unknown>[]): Buffer {
  return Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

function sha(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

describe('session capability snapshots', () => {
  it('derives Claude capability state from lifecycle deltas without raw instruction leakage', () => {
    const body = bytes([
      { type: 'mode', mode: 'normal', timestamp: '2026-07-03T00:00:00.000Z' },
      { type: 'permission-mode', permissionMode: 'bypassPermissions', timestamp: '2026-07-03T00:00:01.000Z' },
      {
        type: 'user',
        timestamp: '2026-07-03T00:00:02.000Z',
        cwd: '/Users/garybasin/Code/atrium',
        version: '2.1.199',
        gitBranch: 'master',
        entrypoint: 'cli',
      },
      {
        type: 'attachment',
        timestamp: '2026-07-03T00:00:03.000Z',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: ['Read', 'mcp__deepwiki__ask_question', 'mcp__claude_ai_Figma__get_screenshot'],
          removedNames: [],
          readdedNames: [],
          pendingMcpServers: ['RepoPrompt'],
        },
      },
      {
        type: 'attachment',
        timestamp: '2026-07-03T00:00:04.000Z',
        attachment: {
          type: 'agent_listing_delta',
          addedTypes: ['Explore'],
          addedLines: ['- Explore: Read-only search agent. (Tools: Read, Grep)'],
          removedTypes: [],
        },
      },
      {
        type: 'attachment',
        timestamp: '2026-07-03T00:00:05.000Z',
        attachment: {
          type: 'mcp_instructions_delta',
          addedNames: ['deepwiki', 'claude.ai Figma'],
          addedBlocks: ['## deepwiki\nSECRET_DO_NOT_LEAK\nAvailable tools:\n- ask_question'],
          removedNames: [],
        },
      },
      {
        type: 'attachment',
        timestamp: '2026-07-03T00:00:06.000Z',
        attachment: {
          type: 'skill_listing',
          names: ['stress-test'],
          content: '- stress-test: Adversarially stress-test a technical plan. (file: r0/stress-test/SKILL.md)',
        },
      },
      {
        type: 'attachment',
        timestamp: '2026-07-03T00:00:07.000Z',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: [],
          removedNames: ['Read'],
          readdedNames: [],
          pendingMcpServers: [],
        },
      },
    ]);

    const snapshot = deriveSessionCapabilitySnapshot({
      sessionId: 'session-1',
      harness: 'claude',
      sourceSha256: sha(body),
      bytes: body,
      generatedAt: '2026-07-03T00:01:00.000Z',
    });

    expect(snapshot.completeness).toBe('complete');
    expect(snapshot.runtime).toMatchObject({
      mode: 'normal',
      permissionMode: 'bypassPermissions',
      cwd: '.../Code/atrium',
      cliVersion: '2.1.199',
      gitBranch: 'master',
    });
    expect(snapshot.tools.map((tool) => tool.name)).toEqual([
      'mcp__claude_ai_Figma__get_screenshot',
      'mcp__deepwiki__ask_question',
    ]);
    expect(snapshot.mcpServers.map((server) => server.name)).toEqual(['claude.ai Figma', 'deepwiki']);
    expect(snapshot.pendingMcpServers).toEqual([]);
    expect(snapshot.agents[0]).toMatchObject({
      name: 'Explore',
      description: 'Read-only search agent. (Tools: Read, Grep)',
    });
    expect(snapshot.skills[0]).toMatchObject({ name: 'stress-test' });
    expect(snapshot.changes.some((change) => change.removed?.includes('Read'))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_DO_NOT_LEAK');
    expect(snapshot.redactions).toContain(
      'Claude MCP instruction blocks are captured in raw transcript and redacted here.',
    );
  });

  it('derives partial Codex capabilities from runtime context, developer tool text, lazy search, and observed calls', () => {
    const developerText = `# Tools

## Namespace: functions

### Tool definitions
type exec_command = (_: {}) => any;
type update_plan = (_: {}) => any;

### Available skills
- stress-test: Adversarially stress-test a technical plan. (file: r0/stress-test/SKILL.md)
- ui-ux-audit: Mandatory audit workflow for UI/UX changes. (file: r0/ui-ux-audit/SKILL.md)
### How to use skills
`;
    const body = bytes([
      {
        type: 'session_meta',
        timestamp: '2026-07-03T00:00:00.000Z',
        payload: {
          cwd: '/Users/garybasin/Code/atrium',
          originator: 'codex-tui',
          cli_version: '0.142.5',
          source: 'cli',
          thread_source: 'user',
          model_provider: 'openai',
          base_instructions: { text: 'SECRET_BASE_DO_NOT_LEAK' },
          git: { branch: 'master', commit_hash: 'abc123' },
        },
      },
      {
        type: 'turn_context',
        timestamp: '2026-07-03T00:00:01.000Z',
        payload: {
          cwd: '/Users/garybasin/Code/atrium',
          workspace_roots: ['/Users/garybasin/Code/atrium'],
          current_date: '2026-07-02',
          timezone: 'America/Detroit',
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          model: 'gpt-5.5',
          effort: 'xhigh',
          collaboration_mode: { mode: 'default' },
          multi_agent_version: 'v1',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-03T00:00:02.000Z',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: developerText }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-03T00:00:03.000Z',
        payload: {
          type: 'tool_search_output',
          tools: [
            {
              type: 'namespace',
              name: 'multi_agent_v1',
              description: 'Tools for spawning and managing sub-agents.',
              tools: [{ type: 'function', name: 'spawn_agent', description: 'Spawn a sub-agent.' }],
            },
          ],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-03T00:00:04.000Z',
        payload: { type: 'function_call', name: 'exec_command' },
      },
    ]);

    const snapshot = deriveSessionCapabilitySnapshot({
      sessionId: 'session-2',
      harness: 'codex',
      sourceSha256: sha(body),
      bytes: body,
      generatedAt: '2026-07-03T00:01:00.000Z',
    });

    expect(snapshot.completeness).toBe('partial');
    expect(snapshot.runtime).toMatchObject({
      cwd: '.../Code/atrium',
      cliVersion: '0.142.5',
      model: 'gpt-5.5',
      effort: 'xhigh',
      sandboxPolicy: 'danger-full-access',
    });
    expect(snapshot.tools.map((tool) => tool.name)).toEqual([
      'functions.exec_command',
      'functions.update_plan',
      'multi_agent_v1.spawn_agent',
    ]);
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(['stress-test', 'ui-ux-audit']);
    expect(snapshot.observedToolCalls[0]).toMatchObject({ name: 'exec_command', count: 1 });
    expect(snapshot.changes.some((change) => change.source === 'codex.tool_search_output')).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_BASE_DO_NOT_LEAK');
    expect(snapshot.redactions).toContain('Codex base instructions are captured in raw transcript and redacted here.');
  });
});
