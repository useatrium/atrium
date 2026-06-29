// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '../src/api';
import { GitHubConnectionDialog } from '../src/components/GitHubConnectionDialog';

afterEach(cleanup);

function status(overrides: Partial<ConnectionStatus>): ConnectionStatus {
  return {
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
    expect(screen.getAllByText(/Personal token/).length).toBeGreaterThan(0);
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
    expect(screen.getByText('token expired')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect GitHub' })).toBeTruthy();
  });

  it('connects a GitHub App installation from the advanced installation id control', async () => {
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

    fireEvent.click(screen.getByText('App installation'));
    fireEvent.change(screen.getByPlaceholderText('Installation id'), { target: { value: '12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect installation' }));

    expect(onConnect).toHaveBeenCalledWith({ tokenKind: 'app_installation', installationId: '12345' });
  });
});
