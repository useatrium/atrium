// @vitest-environment jsdom
// SpawnDialog collects task + harness + optional repo/branch and emits a config.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpawnDialog } from '../src/sessions/SpawnDialog';

afterEach(cleanup);

describe('SpawnDialog', () => {
  it('disables submit until a task is entered', () => {
    render(<SpawnDialog channelName="#general" onCancel={() => {}} onSpawn={() => {}} />);
    const submit = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'fix the bug' },
    });
    expect(submit.disabled).toBe(false);
  });

  it('emits task + harness + trimmed repo/branch', () => {
    const onSpawn = vi.fn();
    render(<SpawnDialog channelName="#general" onCancel={() => {}} onSpawn={onSpawn} />);
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
    });
  });

  it('omits repo/branch when blank', () => {
    const onSpawn = vi.fn();
    render(<SpawnDialog channelName="#general" onCancel={() => {}} onSpawn={onSpawn} />);
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'do a thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(onSpawn).toHaveBeenCalledWith({ task: 'do a thing', harness: 'codex' });
  });

  it('cancels via the Cancel button', () => {
    const onCancel = vi.fn();
    render(<SpawnDialog channelName="#general" onCancel={onCancel} onSpawn={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
