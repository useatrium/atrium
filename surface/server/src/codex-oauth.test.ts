import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IronControlAdminClient } from './iron-control.js';
import type { PendingOAuthRow, PendingOAuthStore } from './provider-oauth.js';

const { convergeCodexBrokerGrant } = vi.hoisted(() => ({ convergeCodexBrokerGrant: vi.fn() }));
vi.mock('./codex-iron-control.js', () => ({ convergeCodexBrokerGrant }));

import { pollCodexDevice } from './codex-oauth.js';

type State =
  | { stage?: 'device'; deviceAuthId: string; userCode: string }
  | { stage: 'converge'; refreshToken: string; accountId: string };

class FakePendingOAuthStore {
  rows = new Map<string, PendingOAuthRow<State>>();
  consumed: string[] = [];
  events: string[] = [];

  put(id = 'pending-id', state: State = { deviceAuthId: 'device-id', userCode: 'user-code' }): void {
    this.rows.set(id, {
      id,
      userId: 'user-id',
      provider: 'codex',
      kind: 'device',
      state,
      status: 'pending',
      lastError: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
  }

  async get(id: string, userId: string): Promise<PendingOAuthRow<State> | null> {
    const row = this.rows.get(id);
    return row?.userId === userId && row.expiresAt > new Date() ? row : null;
  }

  async updateState(id: string, userId: string, state: State): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.userId !== userId || row.status !== 'pending' || row.expiresAt <= new Date()) return false;
    row.state = state;
    this.events.push('persist');
    return true;
  }

  async consume(id: string, userId: string): Promise<PendingOAuthRow<State> | null> {
    const row = await this.get(id, userId);
    if (!row) return null;
    this.rows.delete(id);
    this.consumed.push(id);
    return row;
  }

  async markError(id: string, message: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = 'error';
      row.lastError = message;
    }
  }
}

function deps(store: FakePendingOAuthStore) {
  return {
    pendingOAuth: store as unknown as PendingOAuthStore,
    ironControl: {} as IronControlAdminClient,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function idToken(accountId = 'account-id'): string {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

function approveFetch(): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(200, { authorization_code: 'code', code_verifier: 'verifier' }))
    .mockResolvedValueOnce(jsonResponse(200, { refresh_token: 'refresh-token', id_token: idToken() }));
}

describe('pollCodexDevice', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    convergeCodexBrokerGrant.mockReset();
  });

  it('returns pending while OpenAI approval is outstanding', async () => {
    const store = new FakePendingOAuthStore();
    store.put();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(403, { error: { code: 'deviceauth_authorization_pending', message: 'Authorization pending' } }),
        ),
    );

    await expect(pollCodexDevice(deps(store), 'user-id', 'workspace-id', 'pending-id')).resolves.toEqual({
      status: 'pending',
    });
  });

  it('persists converge state before converging live and consuming the handshake', async () => {
    const store = new FakePendingOAuthStore();
    store.put();
    vi.stubGlobal('fetch', approveFetch());
    convergeCodexBrokerGrant.mockImplementation(async () => {
      store.events.push('converge');
      expect(store.rows.get('pending-id')?.state).toEqual({
        stage: 'converge',
        refreshToken: 'refresh-token',
        accountId: 'account-id',
      });
      return 'live';
    });

    await expect(pollCodexDevice(deps(store), 'user-id', 'workspace-id', 'pending-id')).resolves.toEqual({
      status: 'connected',
    });
    expect(store.events).toEqual(['persist', 'converge']);
    expect(store.consumed).toEqual(['pending-id']);
  });

  it('keeps a pending converge handshake and retries without calling OpenAI', async () => {
    const store = new FakePendingOAuthStore();
    store.put('pending-id', { stage: 'converge', refreshToken: 'refresh-token', accountId: 'account-id' });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    convergeCodexBrokerGrant.mockResolvedValueOnce('pending').mockResolvedValueOnce('live');

    await expect(pollCodexDevice(deps(store), 'user-id', 'workspace-id', 'pending-id')).resolves.toEqual({
      status: 'finalizing',
    });
    expect(store.consumed).toEqual([]);
    await expect(pollCodexDevice(deps(store), 'user-id', 'workspace-id', 'pending-id')).resolves.toEqual({
      status: 'connected',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries convergence after a transient throw', async () => {
    const store = new FakePendingOAuthStore();
    store.put('pending-id', { stage: 'converge', refreshToken: 'refresh-token', accountId: 'account-id' });
    vi.stubGlobal('fetch', vi.fn());
    convergeCodexBrokerGrant.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce('live');

    await expect(pollCodexDevice(deps(store), 'user-id', 'workspace-id', 'pending-id')).resolves.toEqual({
      status: 'finalizing',
    });
    await expect(pollCodexDevice(deps(store), 'user-id', 'workspace-id', 'pending-id')).resolves.toEqual({
      status: 'connected',
    });
  });

  it('consumes a dead converge handshake and returns the token-rejected error', async () => {
    const store = new FakePendingOAuthStore();
    store.put('pending-id', { stage: 'converge', refreshToken: 'refresh-token', accountId: 'account-id' });
    vi.stubGlobal('fetch', vi.fn());
    convergeCodexBrokerGrant.mockResolvedValue('dead');

    await expect(pollCodexDevice(deps(store), 'user-id', 'workspace-id', 'pending-id')).resolves.toEqual({
      status: 'error',
      message: 'Codex sign-in could not be verified (token rejected). Please connect again.',
    });
    expect(store.consumed).toEqual(['pending-id']);
  });

  it('returns expired for a missing or expired handshake', async () => {
    const store = new FakePendingOAuthStore();
    await expect(pollCodexDevice(deps(store), 'user-id', 'workspace-id', 'missing')).resolves.toEqual({
      status: 'expired',
    });
    store.put();
    store.rows.get('pending-id')!.expiresAt = new Date(0);
    await expect(pollCodexDevice(deps(store), 'user-id', 'workspace-id', 'pending-id')).resolves.toEqual({
      status: 'expired',
    });
  });

  it('accepts legacy device state without a stage field', async () => {
    const store = new FakePendingOAuthStore();
    store.put('pending-id', { deviceAuthId: 'legacy-device', userCode: 'legacy-code' });
    const fetch = approveFetch();
    vi.stubGlobal('fetch', fetch);
    convergeCodexBrokerGrant.mockResolvedValue('live');

    await expect(pollCodexDevice(deps(store), 'user-id', 'workspace-id', 'pending-id')).resolves.toEqual({
      status: 'connected',
    });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      device_auth_id: 'legacy-device',
      user_code: 'legacy-code',
    });
  });
});
