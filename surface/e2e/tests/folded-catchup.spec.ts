import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import {
  apiAs,
  channelId,
  createTestChannel,
  e2eDatabaseUrl,
  goOffline,
  login,
  messageRow,
  openChannel,
  seedEvent,
  unique,
} from './helpers.js';

async function seedOfflineThreadChange(args: {
  actorHandle: string;
  channelId: string;
  original: string;
  edited: string;
  reply: string;
}): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [actor, channel] = await Promise.all([
      client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [args.actorHandle]),
      client.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [args.channelId]),
    ]);
    if (!actor.rows[0] || !channel.rows[0]) throw new Error('missing e2e actor or channel');

    const actorId = actor.rows[0].id;
    const workspaceId = channel.rows[0].workspace_id;
    const rootId = await seedEvent(client, {
      workspaceId,
      channelId: args.channelId,
      type: 'message.posted',
      actorId,
      payload: { text: args.original, client_msg_id: unique('folded-root') },
    });
    await seedEvent(client, {
      workspaceId,
      channelId: args.channelId,
      type: 'message.edited',
      actorId,
      payload: { target: `evt_${rootId}`, text: args.edited },
    });
    await seedEvent(client, {
      workspaceId,
      channelId: args.channelId,
      threadRootEventId: rootId,
      type: 'message.posted',
      actorId,
      payload: { text: args.reply, client_msg_id: unique('folded-reply') },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

test('warm reload catches up with folded edited rows and reply counts', async ({ page, context }) => {
  const room = await createTestChannel('folded-catchup');
  const readerHandle = unique('folded-reader');
  await login(page, readerHandle, 'Folded Reader');
  const roomId = await channelId(page.context().request, room);

  const initialHistory = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/channels/${roomId}/messages` && !url.searchParams.has('after_id');
  });
  await openChannel(page, room);
  await initialHistory;
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          new Promise<boolean>((resolve, reject) => {
            const request = indexedDB.open('atrium-web-cache');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const database = request.result;
              const get = database.transaction('channelTimelines').objectStore('channelTimelines').get(id);
              get.onerror = () => reject(get.error);
              get.onsuccess = () => {
                database.close();
                resolve(get.result != null);
              };
            };
          }),
        roomId,
      ),
    )
    .toBe(true);

  await goOffline(page, context);
  const actorHandle = unique('folded-actor');
  const actorApi = await apiAs(actorHandle, 'Folded Actor');
  await actorApi.dispose();
  const original = unique('folded-original');
  const edited = unique('folded-edited');
  const reply = unique('folded-reply');
  await seedOfflineThreadChange({ actorHandle, channelId: roomId, original, edited, reply });

  let deltaWire: string | null = null;
  let deltaEventTypes: string[] | null = null;
  await page.route('**/api/channels/*/messages?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== `/api/channels/${roomId}/messages` || !url.searchParams.has('after_id')) {
      await route.continue();
      return;
    }
    deltaWire = url.searchParams.get('wire');
    const response = await route.fetch();
    const bodyText = await response.text();
    const body = JSON.parse(bodyText) as { events: Array<{ type: string }> };
    deltaEventTypes = body.events.map((event) => event.type);
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: bodyText,
    });
  });

  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();

  const root = messageRow(page, edited);
  await expect(root).toBeVisible();
  await expect(root.getByText('(edited)', { exact: true })).toBeVisible();
  await expect(root.getByText(reply, { exact: true })).toBeVisible();
  await root.getByRole('button', { name: 'Open thread →' }).click();
  await expect(page.getByTestId('conversation-crumb')).toContainText('1 reply');

  expect(deltaWire).toBe('folded');
  expect(deltaEventTypes).not.toBeNull();
  expect(deltaEventTypes).not.toContain('message.edited');
});
