import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import {
  channelId,
  createTestChannel,
  login,
  messageId,
  messageRow,
  openChannel,
  seedEvent,
  sendMessage,
  unique,
} from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

function sseFrame(event: string, eventId: number, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ ...data, event_id: eventId })}\n\n`;
}

function sessionStreamBody(): string {
  return [
    sseFrame('execution_state', 1, {
      type: 'execution.state',
      status: 'running',
      thread_key: 'thread-e2e-addressability',
      execution_id: 'exe_e2e_addressability',
    }),
    sseFrame('amp_raw_event', 2, {
      type: 'item.completed',
      item: {
        id: 'fc-addressability',
        type: 'fileChange',
        changes: [{ path: '/home/agent/workspace/addressability.txt', kind: 'update', diff: '@@\n-old\n+new' }],
      },
    }),
  ].join('');
}

async function injectSession(args: { handle: string; channelId: string; title: string }): Promise<string> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [args.handle]);
    const channel = await client.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
      args.channelId,
    ]);
    if (!user.rows[0] || !channel.rows[0]) throw new Error('missing e2e user or channel');
    const userId = user.rows[0].id;
    const workspaceId = channel.rows[0].workspace_id;
    const session = await client.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, $3, 'codex', $4, 'running', $5, $5, 'exe_addressability', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('addressability')}`, args.title, userId],
    );
    const sessionId = session.rows[0]!.id;
    const rootId = await seedEvent(client, {
      workspaceId,
      channelId: args.channelId,
      type: 'session.spawned',
      actorId: userId,
      payload: { sessionId, title: args.title, harness: 'codex', by: userId },
    });
    await client.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [rootId, sessionId]);
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

test('open thread URL reload-restores the thread panel', async ({ page }) => {
  const room = await createTestChannel('addr-thread');
  await login(page, unique('addr-threader'), 'Address Threader');
  const roomId = await channelId(page.context().request, room);
  await openChannel(page, room);

  const root = unique('addressable-root');
  await sendMessage(page, root, room);
  const rootId = await messageId(page, root);

  const row = messageRow(page, root);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Reply in thread').click({ force: true });

  await expect(page).toHaveURL(new RegExp(`/c/${roomId}/t/${rootId}`));
  await expect(page.getByRole('button', { name: 'Close thread' })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/c/${roomId}/t/${rootId}`));
  await expect(page.getByRole('button', { name: 'Close thread' })).toBeVisible();
  await expect(page.getByPlaceholder('Reply…')).toBeVisible();
});

test('pinned work drawer Changes tab is URL-driven and reload-restored', async ({ page }) => {
  const room = await createTestChannel('addr-work');
  const handle = unique('addr-work');
  await login(page, handle, 'Address Work');
  const roomId = await channelId(page.context().request, room);
  const title = unique('addressability-work-session');
  const sessionId = await injectSession({ handle, channelId: roomId, title });
  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: sessionStreamBody(),
    });
  });

  await page.goto(`/c/${roomId}/s/${sessionId}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByTestId('changes-strip').click();
  await expect(page.getByTestId('work-drawer')).toBeVisible();
  await page.getByRole('button', { name: 'Pin work drawer' }).click();

  // Pinning writes ?work= and (in split layout) auto-focuses, which is also
  // URL-explicit — assert params individually rather than the exact string.
  await expect.poll(() => new URL(page.url()).searchParams.get('work')).toBe('changes');
  await expect(page).toHaveURL(new RegExp(`/c/${roomId}/s/${sessionId}\\?`));
  await page.reload();
  await expect(page.getByTestId('work-drawer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unpin work drawer' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /What changed/ })).toHaveAttribute('aria-selected', 'true');
});

test('focus layout is URL-driven and reload-restored', async ({ page }) => {
  const room = await createTestChannel('addr-focus');
  const handle = unique('addr-focus');
  await login(page, handle, 'Address Focus');
  const roomId = await channelId(page.context().request, room);
  const title = unique('addressability-focus-session');
  const sessionId = await injectSession({ handle, channelId: roomId, title });
  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: sessionStreamBody(),
    });
  });

  await page.goto(`/c/${roomId}/s/${sessionId}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  // View controls live behind the header overflow menu now.
  await page.getByRole('button', { name: 'Agent actions' }).click();
  await page.getByRole('button', { name: 'Expand to focus view' }).click();

  await expect(page).toHaveURL(new RegExp(`/c/${roomId}/s/${sessionId}\\?view=focus$`));
  await page.reload();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Agent actions' }).click();
  await expect(page.getByRole('button', { name: 'Collapse to split view' })).toBeVisible();
});
