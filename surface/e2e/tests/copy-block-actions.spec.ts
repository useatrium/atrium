import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { baseURL, channelId, createTestChannel, login, sendMessage, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

async function injectSession(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<{ sessionId: string; entryHandle: string; entryText: string }> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  const threadKey = `thread-${unique('copy-block')}`;
  const entryUid = `e2e-copy-${unique('record')}`;
  const entryHandle = `rec_${entryUid}`;
  const itemId = `agent-${unique('copy-item')}`;
  const entryText = 'Browser E2E transcript copy target.';
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
       VALUES ($1, $2, $3, 'codex', $4, 'running', $5, $5, 'exe_e2e_copy_block', 1)
       RETURNING id`,
      [workspaceId, args.channelId, threadKey, args.title, userId],
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
    await client.query(
      `INSERT INTO session_records
         (session_id, event_id, seq, entry_uid, kind, actor, driver, view_tier, text, meta, ts)
       VALUES ($1, 2, 1, $2, 'message', 'agent', 'codex', 'lean', $3, $4::jsonb, now())`,
      [sessionId, entryUid, entryText, JSON.stringify({ itemId, messageId: itemId })],
    );
    await client.query('COMMIT');
    return { sessionId, entryHandle, entryText };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

function sseFrame(event: string, eventId: number, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ ...data, event_id: eventId })}\n\n`;
}

async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
}

async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test('channel block copy actions show success and write expected clipboard values', async ({ page }) => {
  await grantClipboard(page);
  const text = `copy block channel ${unique('message')}`;

  await login(page, unique('copy-channel'), 'Copy Channel');
  await sendMessage(page, text);

  const row = page.locator('[data-eid]').filter({ hasText: text }).first();
  await expect(row).toBeVisible();
  await row.hover();

  await row.getByRole('button', { name: 'Copy block text' }).click();
  await expect(row.getByRole('button', { name: 'Copied block text' })).toBeVisible();
  await expect.poll(() => clipboardText(page)).toBe(text);

  await row.hover();
  await row.getByRole('button', { name: 'Copy entry link' }).click();
  await expect(row.getByRole('button', { name: 'Copied entry link' })).toBeVisible();
  await expect.poll(() => clipboardText(page)).toContain(`${baseURL}/e/`);
});

test('session transcript block copy actions show success and write expected clipboard values', async ({ page }) => {
  await grantClipboard(page);
  const room = await createTestChannel('copy-session');
  const handle = unique('copy-session');
  await login(page, handle, 'Copy Session');
  const roomId = await channelId(page.context().request, room);
  const { sessionId, entryHandle, entryText } = await injectSession({
    handle,
    channelId: roomId,
    title: unique('copy-session-title'),
  });
  const stamp = new Date().toISOString();

  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body:
        sseFrame('execution_state', 1, {
          type: 'execution.state',
          status: 'running',
          thread_key: `thread-${sessionId}`,
          execution_id: 'exe_e2e_copy_block',
          atrium_ts: stamp,
        }) +
        sseFrame('amp_raw_event', 2, {
          type: 'item.completed',
          item: { id: `agent-${entryHandle}`, type: 'agentMessage', text: entryText },
          recordHandles: [
            {
              handle: entryHandle,
              kind: 'message',
              actor: 'agent',
              meta: { itemId: `agent-${entryHandle}`, messageId: `agent-${entryHandle}` },
            },
          ],
          atrium_ts: stamp,
        }),
    });
  });

  await page.goto(`/s/${sessionId}`);
  const transcriptText = page.getByText(entryText, { exact: true });
  const transcriptRow = page.locator(`[data-entry-handle="${entryHandle}"]`);
  await expect(transcriptRow).toBeVisible({ timeout: 15_000 });
  await expect(transcriptText).toBeVisible({ timeout: 15_000 });
  await transcriptRow.hover({ position: { x: 12, y: 12 } });

  await transcriptRow.getByRole('button', { name: 'Copy block text' }).click();
  await expect(transcriptRow.getByRole('button', { name: 'Copied block text' })).toBeVisible();
  await expect.poll(() => clipboardText(page)).toBe(entryText);

  await transcriptRow.hover({ position: { x: 12, y: 12 } });
  await transcriptRow.getByRole('button', { name: 'Copy entry link' }).click();
  await expect(transcriptRow.getByRole('button', { name: 'Copied entry link' })).toBeVisible();
  await expect.poll(() => clipboardText(page)).toBe(`${baseURL}/e/${entryHandle}`);
});
