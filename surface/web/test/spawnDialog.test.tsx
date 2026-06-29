// @vitest-environment jsdom
// SpawnDialog collects task + harness + optional repo/branch and emits a config.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpawnDialog } from '../src/sessions/SpawnDialog';

afterEach(cleanup);

const connectedCodex = {
  provider: 'codex' as const,
  connected: true,
  status: 'connected' as const,
  lastValidatedAt: new Date().toISOString(),
  lastError: null,
  updatedAt: new Date().toISOString(),
};

const connectedGitHub = {
  id: 'github:app_user',
  provider: 'github' as const,
  workspaceId: 'workspace-1',
  connected: true,
  status: 'connected' as const,
  tokenKind: 'app_user' as const,
  accountLogin: 'octo',
  accountLabel: 'octo',
  scopes: [],
  capabilities: {},
  metadata: {},
  identities: [],
  lastValidatedAt: null,
  lastError: null,
  updatedAt: null,
};

const codexProfile = {
  id: 'profile-1',
  provider: 'codex' as const,
  name: 'Careful Codex',
  currentVersionId: 'version-1',
  currentVersion: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('SpawnDialog', () => {
  it('disables submit until a task is entered', () => {
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={() => {}}
        providerStatuses={{ codex: connectedCodex }}
      />,
    );
    const submit = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'fix the bug' },
    });
    expect(submit.disabled).toBe(false);
  });

  it('emits task + harness + trimmed repo/branch', () => {
    const onSpawn = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={onSpawn}
        providerStatuses={{ codex: connectedCodex }}
        githubConnection={connectedGitHub}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: '  ship it  ' },
    });
    fireEvent.change(screen.getByPlaceholderText('owner/name'), {
      target: { value: ' acme/app ' },
    });
    fireEvent.change(screen.getByPlaceholderText('main'), { target: { value: ' dev ' } });
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(onSpawn).toHaveBeenCalledWith({
      task: 'ship it',
      harness: 'codex',
      repo: 'acme/app',
      branch: 'dev',
      repos: [{ repo: 'acme/app', ref: 'dev' }],
    });
  });

  it('omits repo/branch when blank', () => {
    const onSpawn = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={onSpawn}
        providerStatuses={{ codex: connectedCodex }}
        githubConnection={connectedGitHub}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'do a thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(onSpawn).toHaveBeenCalledWith({ task: 'do a thing', harness: 'codex' });
  });

  it('hides GitHub identity controls until a repo is selected', () => {
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={() => {}}
        providerStatuses={{ codex: connectedCodex }}
        githubConnection={connectedGitHub}
      />,
    );

    expect(screen.queryByLabelText(/GitHub identity/)).toBeNull();
    expect(screen.queryByText(/^GitHub:/)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('owner/name'), {
      target: { value: 'acme/app' },
    });

    expect(screen.getByLabelText(/GitHub identity/)).toBeTruthy();
    expect(screen.getByText('GitHub: @octo as user')).toBeTruthy();
  });

  it('emits working and reference repo specs', () => {
    const onSpawn = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={onSpawn}
        providerStatuses={{ codex: connectedCodex }}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'wire repos' },
    });
    fireEvent.change(screen.getByPlaceholderText('owner/name'), {
      target: { value: ' acme/app ' },
    });
    fireEvent.change(screen.getByPlaceholderText('main'), { target: { value: ' dev ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add reference repo' }));
    fireEvent.change(screen.getAllByPlaceholderText('owner/name')[1]!, {
      target: { value: ' acme/docs ' },
    });
    fireEvent.change(screen.getByPlaceholderText('ref'), { target: { value: ' docs-main ' } });
    fireEvent.change(screen.getByPlaceholderText('subdir'), { target: { value: ' docs ' } });

    expect(screen.getByText('Working repo + 1 reference repo')).toBeTruthy();
    expect(screen.getByText('mounts under ~/repos')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

    expect(onSpawn).toHaveBeenCalledWith({
      task: 'wire repos',
      harness: 'codex',
      repo: 'acme/app',
      branch: 'dev',
      repos: [
        { repo: 'acme/app', ref: 'dev' },
        { repo: 'acme/docs', ref: 'docs-main', subdir: 'docs' },
      ],
    });
  });

  it('emits selected profile ids', () => {
    const onSpawn = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={onSpawn}
        providerStatuses={{ codex: connectedCodex }}
        profiles={[codexProfile]}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'use my profile' },
    });
    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'profile-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(onSpawn).toHaveBeenCalledWith({
      task: 'use my profile',
      harness: 'codex',
      agentProfileId: 'profile-1',
      agentProfileVersionId: 'version-1',
    });
  });

  it('cancels via the Cancel button', () => {
    const onCancel = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={onCancel}
        onSpawn={() => {}}
        providerStatuses={{ codex: connectedCodex }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('offers Claude subscription connection without blocking Claude Code', () => {
    const onConnect = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={() => {}}
        providerStatuses={{
          codex: connectedCodex,
          'claude-code': {
            provider: 'claude-code',
            connected: false,
            status: 'needs_auth',
            lastValidatedAt: null,
            lastError: null,
            updatedAt: null,
          },
        }}
        onConnectProvider={onConnect}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'use claude' },
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'claude-code' } });

    expect((screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Claude' }));
    expect(onConnect).toHaveBeenCalledWith('claude-code');
  });

  it('offers Codex subscription connection without blocking Codex', () => {
    const onConnect = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={() => {}}
        providerStatuses={{
          codex: {
            provider: 'codex',
            connected: false,
            status: 'needs_auth',
            lastValidatedAt: null,
            lastError: null,
            updatedAt: null,
          },
        }}
        onConnectProvider={onConnect}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'use codex' },
    });

    expect((screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Codex' }));
    expect(onConnect).toHaveBeenCalledWith('codex');
  });

  it('offers a compact GitHub connection affordance near repo input', () => {
    const onConnectGitHub = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={() => {}}
        providerStatuses={{ codex: connectedCodex }}
        githubConnection={{
          id: 'github:public_read',
          provider: 'github',
          workspaceId: 'workspace-1',
          connected: false,
          status: 'public_read',
          tokenKind: 'public_read',
          accountLogin: null,
          accountLabel: null,
          scopes: [],
          capabilities: {},
          metadata: {},
          identities: [],
          lastValidatedAt: null,
          lastError: null,
          updatedAt: null,
        }}
        onConnectGitHub={onConnectGitHub}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));

    expect(onConnectGitHub).toHaveBeenCalled();
  });

  it('includes private repo intent in spawn config', () => {
    const onSpawn = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={onSpawn}
        providerStatuses={{ codex: connectedCodex }}
        githubConnection={connectedGitHub}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'work privately' },
    });
    fireEvent.change(screen.getByPlaceholderText('owner/name'), {
      target: { value: 'acme/private' },
    });
    fireEvent.click(screen.getByLabelText('Private repo'));
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

    expect(onSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'acme/private',
        repos: [{ repo: 'acme/private', private: true }],
      }),
    );
  });

  it('emits a selected GitHub identity override', () => {
    const onSpawn = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={onSpawn}
        providerStatuses={{ codex: connectedCodex }}
        githubConnection={{ ...connectedGitHub, tokenKind: 'app_installation' }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'work with app identity' },
    });
    fireEvent.change(screen.getByPlaceholderText('owner/name'), {
      target: { value: 'acme/private' },
    });
    fireEvent.change(screen.getByLabelText(/GitHub identity/), {
      target: { value: 'app_installation' },
    });
    expect(screen.getByText('GitHub: app install for octo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

    expect(onSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        githubIdentityMode: 'app_installation',
      }),
    );
  });

  it('blocks private working repo spawn until GitHub is connected', () => {
    const onSpawn = vi.fn();
    const onConnectGitHub = vi.fn();
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={onSpawn}
        providerStatuses={{ codex: connectedCodex }}
        githubConnection={{
          ...connectedGitHub,
          id: 'github:public_read',
          connected: false,
          status: 'public_read',
          tokenKind: 'public_read',
          accountLogin: null,
          accountLabel: null,
        }}
        onConnectGitHub={onConnectGitHub}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'work privately' },
    });
    fireEvent.change(screen.getByPlaceholderText('owner/name'), {
      target: { value: 'acme/private' },
    });
    fireEvent.click(screen.getByLabelText('Private repo'));

    expect((screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Connect GitHub before starting a session with private repositories.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    expect(onConnectGitHub).toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('blocks private reference repo spawn until GitHub is connected', () => {
    render(
      <SpawnDialog
        channelName="#general"
        onCancel={() => {}}
        onSpawn={() => {}}
        providerStatuses={{ codex: connectedCodex }}
        githubConnection={{
          ...connectedGitHub,
          id: 'github:public_read',
          connected: false,
          status: 'public_read',
          tokenKind: 'public_read',
          accountLogin: null,
          accountLabel: null,
        }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'inspect private dependency' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add reference repo' }));
    fireEvent.change(screen.getByLabelText('Reference repo'), {
      target: { value: 'acme/reference-private' },
    });
    fireEvent.click(screen.getByLabelText('Private'));

    expect((screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Connect GitHub before starting a session with private repositories.')).toBeTruthy();
  });
});
