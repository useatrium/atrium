// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfileProposal } from '../src/api';
import { ProfileChangesBanner } from '../src/sessions/SessionBanners';

afterEach(cleanup);

describe('SessionBanners', () => {
  it('renders profile proposal counts and dispatches profile actions', () => {
    const onAction = vi.fn();
    const first = proposal({
      id: 'proposal-1',
      provider: 'codex',
      proposal: {
        manifest: {
          provider: 'codex',
          adapterVersion: 'test',
          settings: { approvalPolicy: 'never', sandbox: 'workspace-write' },
          mcpServers: { filesystem: { command: 'mcp-server-filesystem' } },
          bundles: [{ path: 'bin/tool', role: 'tool', sha256: 'bundle-sha', sizeBytes: 42 }],
          excluded: [{ path: 'node_modules', reason: 'too large' }],
        },
        provider: 'codex',
        adapterVersion: 'test',
        sourceHashes: [],
        riskSummary: riskSummary({ blockedSecrets: 2 }),
      },
      riskSummary: riskSummary({ blockedSecrets: 2 }),
    });

    render(
      <ProfileChangesBanner
        proposals={[first, proposal({ id: 'proposal-2' })]}
        busyKey={null}
        error={null}
        onAction={onAction}
      />,
    );

    expect(screen.getByTestId('profile-changes-banner')).toBeTruthy();
    expect(screen.getByText('profile changes')).toBeTruthy();
    expect(
      screen.getByText(
        'Codex proposed 2 settings, 1 MCP servers, 1 bundles; 1 excluded; 2 secret-shaped values blocked',
      ),
    ).toBeTruthy();
    expect(screen.getByText('1 more pending')).toBeTruthy();

    fireEvent.click(screen.getByText('Save as new'));
    expect(onAction).toHaveBeenCalledWith(first, 'save-new');
  });
});

function proposal(overrides: Partial<AgentProfileProposal> = {}): AgentProfileProposal {
  const base: AgentProfileProposal = {
    id: 'proposal-1',
    sessionId: 'session-1',
    provider: 'claude-code',
    baseProfileVersionId: null,
    adapterVersion: 'test',
    status: 'pending',
    source: 'session',
    proposal: {
      provider: 'claude-code',
      adapterVersion: 'test',
      sourceHashes: [],
      manifest: {
        provider: 'claude-code',
        adapterVersion: 'test',
        settings: {},
        mcpServers: {},
        bundles: [],
        excluded: [],
      },
      riskSummary: riskSummary(),
    },
    riskSummary: riskSummary(),
    diff: { added: [], changed: [], removed: [] },
    createdAt: '2026-06-28T13:05:00.000Z',
    updatedAt: '2026-06-28T13:05:00.000Z',
    resolvedAt: null,
  };
  return { ...base, ...overrides };
}

function riskSummary(overrides: Partial<AgentProfileProposal['riskSummary']> = {}): AgentProfileProposal['riskSummary'] {
  return {
    labels: [],
    blockedSecrets: 0,
    executableItems: 0,
    unsupportedItems: 0,
    warnings: [],
    ...overrides,
  };
}
