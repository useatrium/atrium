import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  canAccessChannel,
  canAccessFile,
  createChannel,
  createWorkspace,
  listChannelsFor,
  listUsers,
  listVisibleSyncEvents,
  postMessage,
  searchMessages,
  type Channel,
} from '../src/events.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedMember, truncateAll } from './helpers.js';

let pool: pg.Pool;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

interface VisibilityFixture {
  workspaceA: string;
  workspaceB: string;
  channelA: Channel;
  channelB: Channel;
  alice: string;
  bob: string;
  carol: string;
}

async function seedVisibilityFixture(): Promise<VisibilityFixture> {
  const { workspace: workspaceA } = await createWorkspace(pool, { name: 'a' });
  const { workspace: workspaceB } = await createWorkspace(pool, { name: 'b' });
  const alice = await seedMember(pool, workspaceA.id, `alice-${randomUUID()}`, 'Alice');
  const bob = await seedMember(pool, workspaceB.id, `bob-${randomUUID()}`, 'Bob');
  const carol = await seedMember(pool, workspaceA.id, `carol-${randomUUID()}`, 'Carol');
  await addWorkspaceMember(pool, workspaceB.id, carol);
  const { channel: channelA } = await createChannel(pool, {
    workspaceId: workspaceA.id,
    name: `general-a-${randomUUID().slice(0, 8)}`,
    actorId: alice,
  });
  const { channel: channelB } = await createChannel(pool, {
    workspaceId: workspaceB.id,
    name: `general-b-${randomUUID().slice(0, 8)}`,
    actorId: bob,
  });
  return { workspaceA: workspaceA.id, workspaceB: workspaceB.id, channelA, channelB, alice, bob, carol };
}

async function insertFile(workspaceId: string, uploaderId: string, filename: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO files (workspace_id, uploader_id, filename, content_type, size_bytes, s3_key)
     VALUES ($1, $2, $3, 'text/plain', 12, $4)
     RETURNING id`,
    [workspaceId, uploaderId, filename, `test/${filename}`],
  );
  return res.rows[0]!.id;
}

describe('workspace-scoped public visibility', () => {
  it('scopes public channels, sync events, search hits, files, and user lists to shared workspaces', async () => {
    const fx = await seedVisibilityFixture();
    const fileA = await insertFile(fx.workspaceA, fx.alice, 'a.txt');
    const fileB = await insertFile(fx.workspaceB, fx.bob, 'b.txt');
    const eventA = await postMessage(pool, {
      workspaceId: fx.workspaceA,
      channelId: fx.channelA.id,
      actorId: fx.alice,
      text: 'tenantvisible alpha',
      attachments: [{ id: fileA, filename: 'a.txt', contentType: 'text/plain', size: 12 }],
    });
    const eventB = await postMessage(pool, {
      workspaceId: fx.workspaceB,
      channelId: fx.channelB.id,
      actorId: fx.bob,
      text: 'tenantvisible beta',
      attachments: [{ id: fileB, filename: 'b.txt', contentType: 'text/plain', size: 12 }],
    });

    await expect(listChannelsFor(pool, fx.alice).then((channels) => channels.map((c) => c.id))).resolves.toEqual([
      fx.channelA.id,
    ]);
    await expect(listChannelsFor(pool, fx.bob).then((channels) => channels.map((c) => c.id))).resolves.toEqual([
      fx.channelB.id,
    ]);
    await expect(listChannelsFor(pool, fx.carol).then((channels) => channels.map((c) => c.id).sort())).resolves.toEqual(
      [fx.channelA.id, fx.channelB.id].sort(),
    );

    await expect(canAccessChannel(pool, fx.alice, fx.channelA.id)).resolves.toBe(true);
    await expect(canAccessChannel(pool, fx.alice, fx.channelB.id)).resolves.toBe(false);
    await expect(canAccessChannel(pool, fx.bob, fx.channelA.id)).resolves.toBe(false);
    await expect(canAccessChannel(pool, fx.bob, fx.channelB.id)).resolves.toBe(true);
    await expect(canAccessChannel(pool, fx.carol, fx.channelA.id)).resolves.toBe(true);
    await expect(canAccessChannel(pool, fx.carol, fx.channelB.id)).resolves.toBe(true);

    const aliceSync = await listVisibleSyncEvents(pool, { userId: fx.alice, after: 0, limit: 100 });
    const bobSync = await listVisibleSyncEvents(pool, { userId: fx.bob, after: 0, limit: 100 });
    const carolSync = await listVisibleSyncEvents(pool, { userId: fx.carol, after: 0, limit: 100 });
    expect(aliceSync.events.map((event) => event.id)).toContain(eventA.id);
    expect(aliceSync.events.map((event) => event.id)).not.toContain(eventB.id);
    expect(bobSync.events.map((event) => event.id)).not.toContain(eventA.id);
    expect(bobSync.events.map((event) => event.id)).toContain(eventB.id);
    expect(carolSync.events.map((event) => event.id)).toEqual(expect.arrayContaining([eventA.id, eventB.id]));

    await expect(searchMessages(pool, { query: 'alpha', userId: fx.alice })).resolves.toHaveLength(1);
    await expect(searchMessages(pool, { query: 'beta', userId: fx.alice })).resolves.toHaveLength(0);
    await expect(searchMessages(pool, { query: 'alpha', userId: fx.bob })).resolves.toHaveLength(0);
    await expect(searchMessages(pool, { query: 'beta', userId: fx.bob })).resolves.toHaveLength(1);
    await expect(searchMessages(pool, { query: 'tenantvisible', userId: fx.carol })).resolves.toHaveLength(2);

    await expect(canAccessFile(pool, fx.alice, fileA)).resolves.toBe(true);
    await expect(canAccessFile(pool, fx.alice, fileB)).resolves.toBe(false);
    await expect(canAccessFile(pool, fx.bob, fileA)).resolves.toBe(false);
    await expect(canAccessFile(pool, fx.bob, fileB)).resolves.toBe(true);
    await expect(canAccessFile(pool, fx.carol, fileA)).resolves.toBe(true);
    await expect(canAccessFile(pool, fx.carol, fileB)).resolves.toBe(true);

    await expect(listUsers(pool, fx.alice).then((users) => users.map((u) => u.id).sort())).resolves.toEqual(
      [fx.alice, fx.carol].sort(),
    );
    await expect(listUsers(pool, fx.bob).then((users) => users.map((u) => u.id).sort())).resolves.toEqual(
      [fx.bob, fx.carol].sort(),
    );
    await expect(listUsers(pool, fx.carol).then((users) => users.map((u) => u.id).sort())).resolves.toEqual(
      [fx.alice, fx.bob, fx.carol].sort(),
    );
  });

  it('keeps private channels bounded by channel membership even inside a shared workspace', async () => {
    const fx = await seedVisibilityFixture();
    await addWorkspaceMember(pool, fx.workspaceA, fx.bob);
    const { channel: privateChannel } = await createChannel(pool, {
      workspaceId: fx.workspaceA,
      name: `private-${randomUUID().slice(0, 8)}`,
      actorId: fx.alice,
      private: true,
    });
    const privateEvent = await postMessage(pool, {
      workspaceId: fx.workspaceA,
      channelId: privateChannel.id,
      actorId: fx.alice,
      text: 'members-only-alpha',
    });

    await expect(canAccessChannel(pool, fx.alice, privateChannel.id)).resolves.toBe(true);
    await expect(canAccessChannel(pool, fx.bob, privateChannel.id)).resolves.toBe(false);
    await expect(listChannelsFor(pool, fx.alice).then((channels) => channels.map((c) => c.id))).resolves.toContain(
      privateChannel.id,
    );
    await expect(listChannelsFor(pool, fx.bob).then((channels) => channels.map((c) => c.id))).resolves.not.toContain(
      privateChannel.id,
    );
    await expect(searchMessages(pool, { query: 'members-only-alpha', userId: fx.alice })).resolves.toHaveLength(1);
    await expect(searchMessages(pool, { query: 'members-only-alpha', userId: fx.bob })).resolves.toHaveLength(0);

    const aliceSync = await listVisibleSyncEvents(pool, { userId: fx.alice, after: 0, limit: 100 });
    const bobSync = await listVisibleSyncEvents(pool, { userId: fx.bob, after: 0, limit: 100 });
    expect(aliceSync.events.map((event) => event.id)).toContain(privateEvent.id);
    expect(bobSync.events.map((event) => event.id)).not.toContain(privateEvent.id);
  });

  it('keeps sync cursor and limited semantics over the scoped visible set', async () => {
    const fx = await seedVisibilityFixture();
    const before = await listVisibleSyncEvents(pool, { userId: fx.alice, after: 0, limit: 100 });
    const cursor = before.nextCursor;
    const visible1 = await postMessage(pool, {
      workspaceId: fx.workspaceA,
      channelId: fx.channelA.id,
      actorId: fx.alice,
      text: 'cursor-visible-1',
    });
    const hidden = await postMessage(pool, {
      workspaceId: fx.workspaceB,
      channelId: fx.channelB.id,
      actorId: fx.bob,
      text: 'cursor-hidden',
    });
    const visible2 = await postMessage(pool, {
      workspaceId: fx.workspaceA,
      channelId: fx.channelA.id,
      actorId: fx.alice,
      text: 'cursor-visible-2',
    });

    const page = await listVisibleSyncEvents(pool, { userId: fx.alice, after: cursor, limit: 100 });
    expect(page.limited).toBe(false);
    expect(page.events.map((event) => event.id)).toEqual([visible1.id, visible2.id]);
    expect(page.events.map((event) => event.id)).not.toContain(hidden.id);
    expect(page.nextCursor).toBe(visible2.id);

    const limited = await listVisibleSyncEvents(pool, { userId: fx.alice, after: cursor, limit: 1 });
    expect(limited).toEqual({ events: [], nextCursor: visible2.id, limited: true });
  });
});
