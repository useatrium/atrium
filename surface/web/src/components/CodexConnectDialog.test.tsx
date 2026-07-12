// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexConnectDialog } from './CodexConnectDialog';

const { pollCodexDeviceFlow, startCodexDeviceFlow } = vi.hoisted(() => ({
  pollCodexDeviceFlow: vi.fn(),
  startCodexDeviceFlow: vi.fn(),
}));

vi.mock('../api', () => ({
  pollCodexDeviceFlow,
  PROVIDER_CREDENTIALS_REFRESH_SENTINEL: '__refresh__',
  startCodexDeviceFlow,
}));

const staleError = 'Codex authentication failed. Reconnect Codex to continue this session.';

function renderDialog(onSave = vi.fn().mockResolvedValue(undefined), onCancel = vi.fn()) {
  render(
    <CodexConnectDialog
      status={{ connected: false, lastError: staleError } as never}
      onCancel={onCancel}
      onSave={onSave}
      onDisconnect={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  return { onCancel, onSave };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function settleStart() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  startCodexDeviceFlow.mockReset().mockResolvedValue({
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://example.com/device',
    pendingId: 'pending-1',
    intervalSec: 1,
  });
  pollCodexDeviceFlow.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CodexConnectDialog', () => {
  it('labels the stale credential error while waiting', async () => {
    pollCodexDeviceFlow.mockResolvedValue({ status: 'pending' });
    renderDialog();
    await settleStart();

    expect(screen.getByText('Waiting for approval on OpenAI...')).toBeTruthy();
    expect(screen.getByText('Reconnecting because:')).toBeTruthy();
    expect(screen.getByText(staleError)).toBeTruthy();
  });

  it('shows finalizing without the stale error and disables connection buttons', async () => {
    pollCodexDeviceFlow.mockResolvedValueOnce({ status: 'finalizing' });
    renderDialog();

    await settleStart();
    await advance(1000);

    expect(screen.getByText('Finalizing connection…')).toBeTruthy();
    expect(screen.queryByText(staleError)).toBeNull();
    expect(screen.getByRole('button', { name: 'Open OpenAI sign-in' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Connect' }).hasAttribute('disabled')).toBe(true);
  });

  it('continues polling after finalizing and completes the dialog', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    pollCodexDeviceFlow.mockResolvedValueOnce({ status: 'finalizing' }).mockResolvedValueOnce({ status: 'connected' });
    renderDialog(onSave, onCancel);

    await settleStart();
    await advance(1000);
    await advance(2000);

    expect(onSave).toHaveBeenCalledWith('__refresh__');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows only the flow error and a retry action after a terminal error', async () => {
    pollCodexDeviceFlow.mockResolvedValueOnce({ status: 'error', message: 'New sign-in failed' });
    renderDialog();

    await settleStart();
    await advance(1000);

    expect(screen.getByRole('alert').textContent).toContain('New sign-in failed');
    expect(screen.queryByText(staleError)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
