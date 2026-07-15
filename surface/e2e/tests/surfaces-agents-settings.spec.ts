import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { channelId, createTestChannel, login, openChannel, seedEvent, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

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
       VALUES ($1, $2, $3, 'codex', $4, 'running', $5, $5, 'exe_surfaces', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('surface-route')}`, args.title, userId],
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

test('Agents is addressable, reload-restores, lists sessions, and Back returns to chat', async ({ page }) => {
  const room = await createTestChannel('agents-surface');
  const handle = unique('agents-surface');
  await login(page, handle, 'Agents Surface');
  const roomId = await channelId(page.context().request, room);
  await openChannel(page, room);

  const title = unique('agents-surface-title');
  await injectSession({ handle, channelId: roomId, title });

  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole('heading', { name: /^Agents$/ }).first()).toBeVisible();
  // Scope to the Agents surface — the session title also appears in the channel's
  // right-rail card, so an unscoped match is ambiguous (and doesn't prove the
  // surface itself lists it).
  await expect(page.getByTestId('agents-surface').getByText(title, { exact: true })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole('heading', { name: /^Agents$/ }).first()).toBeVisible();
  // Scope to the Agents surface — the session title also appears in the channel's
  // right-rail card, so an unscoped match is ambiguous (and doesn't prove the
  // surface itself lists it).
  await expect(page.getByTestId('agents-surface').getByText(title, { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
});

test('Settings is addressable, reload-restores, and Back returns to chat', async ({ page }) => {
  await login(page, unique('settings-surface'), 'Settings Surface');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: /^Settings$/ }).first()).toBeVisible();
  await expect(page.getByText('Theme')).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: /^Settings$/ }).first()).toBeVisible();
  await expect(page.getByText('Theme')).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
});
