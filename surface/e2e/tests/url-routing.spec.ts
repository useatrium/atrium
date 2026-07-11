import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { channelId, createTestChannel, login, openChannel, unique } from './helpers.js';

const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

async function injectSession(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<string> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [
      args.handle,
    ]);
    const channel = await client.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM channels WHERE id = $1',
      [args.channelId],
    );
    if (!user.rows[0] || !channel.rows[0]) throw new Error('missing e2e user or channel');
    const userId = user.rows[0].id;
    const workspaceId = channel.rows[0].workspace_id;
    const session = await client.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, $3, 'codex', $4, 'running', $5, $5, 'exe_url_routing', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('url-route')}`, args.title, userId],
    );
    const sessionId = session.rows[0]!.id;
    const root = await client.query<{ id: string }>(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       VALUES ($1, $2, 'session.spawned', $3, $4)
       RETURNING id`,
      [
        workspaceId,
        args.channelId,
        userId,
        JSON.stringify({ sessionId, title: args.title, harness: 'codex', by: userId }),
      ],
    );
    await client.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [
      Number(root.rows[0]!.id),
      sessionId,
    ]);
    await client.query('COMMIT');
    return sessionId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

test('selecting a channel updates the URL and reload restores it', async ({ page }) => {
  const room = await createTestChannel('urlchan');
  const handle = unique('url-channel');
  await login(page, handle, 'URL Channel');
  const roomId = await channelId(page.context().request, room);

  await openChannel(page, room);
  await expect(page).toHaveURL(new RegExp(`/c/${roomId}$`));

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/c/${roomId}$`));
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
});

test('creating a channel navigates to its URL and reload restores it', async ({ page }) => {
  const room = unique('created-url');
  await login(page, unique('created-channel'), 'Created Channel');

  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.getByRole('textbox', { name: 'Channel name' }).fill(room);
  await page.getByRole('textbox', { name: 'Channel name' }).press('Enter');

  await expect(page).toHaveURL(/\/c\/[^/]+$/);
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
  const roomId = new URL(page.url()).pathname.split('/').at(-1);
  if (!roomId) throw new Error('created channel URL is missing an id');

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/c/${roomId}$`));
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
});

test('opening a session updates the URL and Back closes it without a document reload', async ({ page }) => {
  const room = await createTestChannel('urlsession');
  const handle = unique('url-session');
  await login(page, handle, 'URL Session');
  const roomId = await channelId(page.context().request, room);
  await openChannel(page, room);

  const title = unique('url-session-title');
  const sessionId = await injectSession({ handle, channelId: roomId, title });
  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: '',
    });
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();

  await page.evaluate(() => {
    (window as Window & { __urlRoutingMarker?: string }).__urlRoutingMarker = 'kept';
  });
  await page
    .getByTestId('session-card')
    .filter({ hasText: title })
    .getByRole('button', { name: title })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/c/${roomId}/s/${sessionId}$`));
  await expect(page.getByRole('button', { name: 'Close agent pane' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/c/${roomId}$`));
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close agent pane' })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __urlRoutingMarker?: string }).__urlRoutingMarker ?? null),
    )
    .toBe('kept');
});

test('switching to Files updates the URL and Back returns to chat', async ({ page }) => {
  await login(page, unique('url-files'), 'URL Files');

  // exact: the workspace can contain channels whose name starts with "files",
  // and a non-exact name match would collide with those channel buttons.
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByRole('heading', { name: /^Files(?: for| \/|$)/ }).first()).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
});
