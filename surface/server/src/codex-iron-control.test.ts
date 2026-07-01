import { describe, expect, it, vi } from 'vitest';
import { convergeCodexBrokerGrant } from './codex-iron-control.js';
import type { IronControlAdminClient } from './iron-control.js';

// Minimal fake iron-control admin client: satisfies the calls convergeCodexBrokerGrant
// makes, and serves broker `status` values in sequence (last one sticks) so we can
// drive the broker-live gate.
function fakeIronControl(statuses: string[]) {
  const calls = { getBroker: 0 };
  const client = {
    upsertPrincipal: vi.fn(async () => ({ id: 'prn_1' })),
    lookupRole: vi.fn(async () => ({ id: 'role_infra' })),
    assignRole: vi.fn(async () => undefined),
    upsertBrokerCredential: vi.fn(async () => ({ id: 'bcr_1', namespace: 'default' })),
    upsertInjectSecret: vi.fn(async (args: { foreignId: string }) => ({ id: `scs_${args.foreignId}` })),
    listPrincipalGrants: vi.fn(async () => []),
    createPrincipalStaticGrant: vi.fn(async () => ({ id: 'grant_1' })),
    getBrokerCredential: vi.fn(async () => {
      const status = statuses[Math.min(calls.getBroker, statuses.length - 1)];
      calls.getBroker += 1;
      return { id: 'bcr_1', namespace: 'default', status };
    }),
  } as unknown as IronControlAdminClient;
  return { client, calls };
}

const args = { workspaceId: 'w1', userId: 'u1', refreshToken: 'rt', accountId: 'acc' };

describe('convergeCodexBrokerGrant broker-live gate', () => {
  it('returns "live" as soon as the broker has minted a token', async () => {
    const { client, calls } = fakeIronControl(['live']);
    expect(await convergeCodexBrokerGrant(client, args)).toBe('live');
    expect(calls.getBroker).toBe(1);
  });

  it('returns "dead" when the broker credential was rejected', async () => {
    const { client } = fakeIronControl(['dead']);
    expect(await convergeCodexBrokerGrant(client, args)).toBe('dead');
  });

  it('polls until the broker becomes live (bootstrapping -> live)', async () => {
    const { client, calls } = fakeIronControl(['bootstrapping', 'bootstrapping', 'live']);
    expect(await convergeCodexBrokerGrant(client, args)).toBe('live');
    expect(calls.getBroker).toBe(3);
  });
});
