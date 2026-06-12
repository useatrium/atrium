import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createWorkspace } from '../src/events.js';
import { addWorkspaceMember, isWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, seedMember, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
let port: number;

const originalAuthDevCodes = config.authDevCodes;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  config.authDevCodes = originalAuthDevCodes;
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
  config.authDevCodes = true;
  app = await buildApp({
    pool,
    rateLimit: false,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterEach(async () => {
  await app.close();
});

async function login(handle: string, displayName = handle) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return {
    cookie: res.headers['set-cookie'] as string,
    token: res.json().token as string,
    user: res.json().user as { id: string; handle: string; displayName: string },
  };
}

async function insertUser(handle: string, displayName = handle): Promise<string> {
  const res = await pool.query<{ id: string }>(
    'INSERT INTO users (handle, display_name) VALUES ($1, $2) RETURNING id',
    [handle, displayName],
  );
  return res.rows[0]!.id;
}

async function requestCode(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/email/request',
    payload: { email },
  });
  expect(res.statusCode).toBe(200);
  return res.json().devCode as string;
}

function openSocket(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket open timeout')), 4000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('workspace routes', () => {
  it('lists only caller workspaces, creates memberships, and adds members by handle', async () => {
    const { workspace: otherWorkspace } = await createWorkspace(pool, { name: 'other' });
    await seedMember(pool, otherWorkspace.id, 'bob', 'Bob');
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');

    const aliceList = await app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: { cookie: alice.cookie },
    });
    expect(aliceList.statusCode).toBe(200);
    expect(aliceList.json().workspaces.map((w: any) => w.id)).toEqual([fx.workspaceId]);

    const bobList = await app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: { cookie: bob.cookie },
    });
    expect(bobList.statusCode).toBe(200);
    expect(bobList.json().workspaces.map((w: any) => w.id)).toEqual([otherWorkspace.id]);

    const created = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { cookie: alice.cookie },
      payload: { name: ' Product ' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().workspace).toMatchObject({ name: 'Product' });
    const productId = created.json().workspace.id as string;
    expect(await isWorkspaceMember(pool, alice.user.id, productId)).toBe(true);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { cookie: alice.cookie },
      payload: { name: 'Product' },
    });
    expect(duplicate.statusCode).toBe(409);

    const nonMemberAdd = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${productId}/members`,
      headers: { cookie: bob.cookie },
      payload: { handle: 'bob' },
    });
    expect(nonMemberAdd.statusCode).toBe(404);

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${productId}/members`,
      headers: { cookie: alice.cookie },
      payload: { handle: 'nobody' },
    });
    expect(unknown.statusCode).toBe(404);

    const added = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${productId}/members`,
      headers: { cookie: alice.cookie },
      payload: { handle: 'bob' },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().member).toMatchObject({ id: bob.user.id, handle: 'bob' });

    const again = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${productId}/members`,
      headers: { cookie: alice.cookie },
      payload: { handle: 'bob' },
    });
    expect(again.statusCode).toBe(200);
    expect(await isWorkspaceMember(pool, bob.user.id, productId)).toBe(true);
  });

  it('auto-joins newly email-created users to the default workspace', async () => {
    const code = await requestCode('newperson@example.com');
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { email: 'newperson@example.com', code },
    });
    expect(verified.statusCode).toBe(200);
    expect(await isWorkspaceMember(pool, verified.json().user.id, fx.workspaceId)).toBe(true);
  });

  it('creates channels in the caller active workspace and rejects users with no workspace', async () => {
    const lonelyId = await insertUser('lonely', 'Lonely');
    const { workspace: workspaceB } = await createWorkspace(pool, { name: 'workspace-b' });
    const memberId = await insertUser('onlyb', 'Only B');
    await addWorkspaceMember(pool, workspaceB.id, memberId);

    const onlyB = await login('onlyb', 'Only B');
    const lonely = await login('lonely', 'Lonely');

    const created = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { cookie: onlyB.cookie },
      payload: { name: 'from-b' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().channel.workspaceId).toBe(workspaceB.id);
    expect(created.json().channel.workspaceId).not.toBe(fx.workspaceId);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { cookie: lonely.cookie },
      payload: { name: 'nope' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('no_workspace');
    expect(lonelyId).toBe(lonely.user.id);
  });

  it('fans public channel.created only to workspace members', async () => {
    const { workspace } = await createWorkspace(pool, { name: 'isolated' });
    const creatorId = await insertUser('creator', 'Creator');
    const outsiderId = await insertUser('outsider', 'Outsider');
    await addWorkspaceMember(pool, workspace.id, creatorId);

    const creator = await login('creator', 'Creator');
    const outsider = await login('outsider', 'Outsider');
    expect(outsider.user.id).toBe(outsiderId);

    const creatorWs = await openSocket(creator.token);
    const outsiderWs = await openSocket(outsider.token);
    const creatorFrames: any[] = [];
    const outsiderFrames: any[] = [];
    creatorWs.on('message', (data) => creatorFrames.push(JSON.parse(data.toString())));
    outsiderWs.on('message', (data) => outsiderFrames.push(JSON.parse(data.toString())));

    const created = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { cookie: creator.cookie },
      payload: { name: 'scoped-news' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().channel.workspaceId).toBe(workspace.id);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(creatorFrames.some((m) => m.event?.type === 'channel.created')).toBe(true);
    expect(outsiderFrames.some((m) => m.event?.type === 'channel.created')).toBe(false);

    creatorWs.close();
    outsiderWs.close();
  });
});
