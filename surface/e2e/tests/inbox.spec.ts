import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { apiAs, channelId, e2eDatabaseUrl, login, seedEvent, unique } from './helpers.js';

async function seedCompletedSession(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<{ sessionId: string }> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [args.handle]);
    const channel = await client.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
      args.channelId,
    ]);
    if (!user.rows[0] || !channel.rows[0]) throw new Error('missing e2e user or channel');

    const session = await client.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation, result_text, completed_at
       )
       VALUES ($1, $2, $3, 'codex', $4, 'completed', $5, $5, 'exe_e2e_inbox', 1, $6, now())
       RETURNING id`,
      [
        channel.rows[0].workspace_id,
        args.channelId,
        `thread-${unique('inbox')}`,
        args.title,
        user.rows[0].id,
        'Completed inbox fixture.',
      ],
    );
    const sessionId = session.rows[0]!.id;
    const rootId = await seedEvent(client, {
      workspaceId: channel.rows[0].workspace_id,
      channelId: args.channelId,
      type: 'session.spawned',
      actorId: user.rows[0].id,
      payload: { sessionId, title: args.title, harness: 'codex', by: user.rows[0].id },
    });
    await client.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [rootId, sessionId]);
    await seedEvent(client, {
      workspaceId: channel.rows[0].workspace_id,
      channelId: args.channelId,
      threadRootEventId: rootId,
      type: 'session.completed',
      actorId: user.rows[0].id,
      payload: { sessionId, status: 'completed', resultExcerpt: 'Completed inbox fixture.' },
    });
    await client.query('COMMIT');
    return { sessionId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

test('Inbox puts an unread completed session in To review and clears it on open', async ({ page }) => {
  const handle = unique('inbox');
  const title = unique('completed-inbox-session');
  await login(page, handle, 'Inbox Reviewer');

  const api = await apiAs(handle, 'Inbox Reviewer');
  const generalId = await channelId(api, 'general');
  await api.dispose();
  const { sessionId } = await seedCompletedSession({ handle, channelId: generalId, title });

  await page.goto('/activity');
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'To review · 1' })).toBeVisible();
  await expect(page.getByText(`${title} · completed`, { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Inbox · 1' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Unread · 1' })).toBeVisible();

  await page.getByText(`${title} · completed`, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${sessionId}`));

  await page.goto('/activity');
  await expect(page.getByRole('tab', { name: 'Reviewed · 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /To review/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Reviewed · 1' }).click();
  await expect(page.getByText(`${title} · completed`, { exact: true })).toBeVisible();
});
