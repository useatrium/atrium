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
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: '  ship it  ' },
    });
    fireEvent.change(screen.getByPlaceholderText('owner/name'), {
      target: { value: ' acme/app ' },
    });
    fireEvent.change(screen.getByPlaceholderText('main'), { target: { value: ' dev ' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'codex' } });
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
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'do a thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(onSpawn).toHaveBeenCalledWith({ task: 'do a thing', harness: 'codex' });
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
});
