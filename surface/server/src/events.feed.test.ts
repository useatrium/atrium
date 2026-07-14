import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { listChannelMessages, postMessage } from './events.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from '../test/helpers.js';

let pool: pg.Pool;
let fixture: Fixture;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fixture = await seedFixture(pool);
});

describe('channel feed reply previews', () => {
  it('materializes the latest reply author and text on its root row', async () => {
    const root = await postMessage(pool, {
      workspaceId: fixture.workspaceId,
      channelId: fixture.channelId,
      actorId: fixture.userId,
      text: 'Root message',
    });
    const reply = await postMessage(pool, {
      workspaceId: fixture.workspaceId,
      channelId: fixture.channelId,
      actorId: fixture.userId,
      threadRootEventId: root.id,
      text: 'Latest reply preview',
    });

    const history = await listChannelMessages(pool, { channelId: fixture.channelId });
    const feedRoot = history.events.find((event) => event.id === root.id);
    expect(feedRoot).toMatchObject({ replyCount: 1, lastReplyId: reply.id });
    expect(feedRoot?.lastReply).toMatchObject({
      id: reply.id,
      authorId: fixture.userId,
      text: 'Latest reply preview',
      agentVoice: false,
      eventType: 'message.posted',
    });
  });

  it('caps feed preview text at 200 characters', async () => {
    const root = await postMessage(pool, {
      workspaceId: fixture.workspaceId,
      channelId: fixture.channelId,
      actorId: fixture.userId,
      text: 'Root message',
    });
    await postMessage(pool, {
      workspaceId: fixture.workspaceId,
      channelId: fixture.channelId,
      actorId: fixture.userId,
      threadRootEventId: root.id,
      text: 'x'.repeat(250),
    });

    const history = await listChannelMessages(pool, { channelId: fixture.channelId });
    expect(history.events.find((event) => event.id === root.id)?.lastReply?.text).toHaveLength(200);
  });
});
