// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeConnectDialog } from './ClaudeConnectDialog';

const { exchangeClaudeCodeOAuth, startClaudeCodeOAuth } = vi.hoisted(() => ({
  exchangeClaudeCodeOAuth: vi.fn(),
  startClaudeCodeOAuth: vi.fn(),
}));

vi.mock('../api', () => ({
  exchangeClaudeCodeOAuth,
  PROVIDER_CREDENTIALS_REFRESH_SENTINEL: '__refresh__',
  startClaudeCodeOAuth,
}));

const staleError = 'Claude authentication failed. Reconnect Claude to continue this session.';

beforeEach(() => {
  startClaudeCodeOAuth.mockReset().mockResolvedValue({
    authorizeUrl: 'https://example.com/authorize',
    pendingId: 'pending-1',
  });
  exchangeClaudeCodeOAuth.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ClaudeConnectDialog', () => {
  it('labels the stale error, then hides it as soon as the exchange succeeds', async () => {
    let finishSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    exchangeClaudeCodeOAuth.mockResolvedValue({ status: 'connected' });
    render(
      <ClaudeConnectDialog
        status={{ connected: false, lastError: staleError } as never}
        onCancel={vi.fn()}
        onSave={onSave}
        onDisconnect={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText('Reconnecting because:')).toBeTruthy();
    expect(screen.getByText(staleError)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Paste Claude code'), { target: { value: 'oauth-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('__refresh__'));
    expect(screen.queryByText(staleError)).toBeNull();
    finishSave?.();
  });
});
