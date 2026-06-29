// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '../src/api';
import { GitHubConnectionDialog } from '../src/components/GitHubConnectionDialog';

afterEach(cleanup);

function status(overrides: Partial<ConnectionStatus>): ConnectionStatus {
  return {
    id: 'github:app_user',
    provider: 'github',
    workspaceId: 'workspace-1',
    connected: true,
    status: 'connected',
    tokenKind: 'app_user',
    accountLogin: 'octo',
    accountLabel: 'octo',
    scopes: [],
    capabilities: {},
    metadata: {},
    lastValidatedAt: null,
    lastError: null,
    updatedAt: null,
    ...overrides,
  };
}

function renderDialog(connection: ConnectionStatus) {
  return render(
    <GitHubConnectionDialog
      available={true}
      status={connection}
      onCancel={vi.fn()}
      onConnect={async () => {}}
      onDisconnect={async () => {}}
    />,
  );
}

describe('GitHubConnectionDialog', () => {
  it('labels GitHub App user, installation, and PAT identities distinctly', () => {
    const { rerender } = renderDialog(status({ tokenKind: 'app_user' }));
    expect(screen.getAllByText(/GitHub user/).length).toBeGreaterThan(0);

    rerender(
      <GitHubConnectionDialog
        available={true}
        status={status({ tokenKind: 'app_installation', accountLabel: 'acme' })}
        onCancel={vi.fn()}
        onConnect={async () => {}}
        onDisconnect={async () => {}}
      />,
    );
    expect(screen.getAllByText(/App installation/).length).toBeGreaterThan(0);

    rerender(
      <GitHubConnectionDialog
        available={true}
        status={status({ tokenKind: 'pat' })}
        onCancel={vi.fn()}
        onConnect={async () => {}}
        onDisconnect={async () => {}}
      />,
    );
    expect(screen.getAllByText(/PAT for @octo/).length).toBeGreaterThan(0);
  });

  it('surfaces reconnect state and the last GitHub auth error', () => {
    renderDialog(
      status({
        connected: false,
        status: 'needs_auth',
        tokenKind: 'app_user',
        lastError: 'token expired',
      }),
    );

    expect(screen.getByText('Reconnect required')).toBeTruthy();
    expect(screen.getAllByText('@octo as GitHub user').length).toBeGreaterThan(0);
    expect(screen.getByText('token expired')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect GitHub user' })).toBeTruthy();
  });

  it('connects a GitHub App installation from the primary installation id control', async () => {
    const onConnect = vi.fn(async () => {});
    render(
      <GitHubConnectionDialog
        available={true}
        status={status({ connected: false, status: 'public_read', tokenKind: 'public_read' })}
        onCancel={vi.fn()}
        onConnect={onConnect}
        onDisconnect={async () => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Installation ID'), { target: { value: '12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub App' }));

    expect(onConnect).toHaveBeenCalledWith({ tokenKind: 'app_installation', installationId: '12345' });
  });

  it('makes active replacement semantics and App ownership explicit', () => {
    renderDialog(status({ tokenKind: 'app_installation', accountLabel: 'acme' }));

    expect(screen.getByText('Active for this workspace')).toBeTruthy();
    expect(screen.getAllByText('App installation for acme').length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        'Connecting another GitHub identity replaces the active identity for future sessions in this workspace.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Connect an installed Atrium GitHub App')).toBeTruthy();
    expect(
      screen.getByText('Use the installation owned by the org or user that should grant repository access.'),
    ).toBeTruthy();
  });

  it('shows workspace, validation, and repo access metadata for connected accounts', () => {
    renderDialog(
      status({
        tokenKind: 'app_installation',
        workspaceId: 'workspace-1',
        capabilities: { repoAccessSummary: '12 selected repositories' },
        lastValidatedAt: '2026-06-29T12:00:00.000Z',
        metadata: {
          installationAccountType: 'Organization',
          installationTargetType: 'Organization',
        },
      }),
    );

    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.getByText('workspace-1')).toBeTruthy();
    expect(screen.getByText('Last checked')).toBeTruthy();
    expect(screen.getByText('Repo access')).toBeTruthy();
    expect(screen.getByText('12 selected repositories')).toBeTruthy();
  });
});
