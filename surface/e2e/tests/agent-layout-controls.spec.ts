import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { channelId, createTestChannel, login, seedEvent, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const proofDir = process.env.AGENT_LAYOUT_PROOF_DIR;
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
    await page.screenshot({ path: join(proofDir, `${name}.png`), fullPage: false });
  }
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
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
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, $3, 'claude-code', $4, 'running', $5, $5, 'exe_layout_proof', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('layout')}`, args.title, userId],
    );
    const sessionId = inserted.rows[0]!.id;
    const rootId = await seedEvent(client, {
      workspaceId,
      channelId: args.channelId,
      type: 'session.spawned',
      actorId: userId,
      payload: { sessionId, title: args.title, harness: 'claude-code', by: userId },
    });
    await client.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [rootId, sessionId]);
    await client.query('COMMIT');
    return sessionId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function openSessionProof(page: Page): Promise<void> {
  const room = await createTestChannel('layout-proof');
  const handle = unique('layout-proof');
  await login(page, handle, 'Layout Proof');
  const roomId = await channelId(page.context().request, room);
  const sessionId = await injectSession({ handle, channelId: roomId, title: 'Verify focused agent layout' });
  const stamp = new Date().toISOString();
  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: `event: execution_state\ndata: ${JSON.stringify({
        type: 'execution.state',
        status: 'running',
        thread_key: 'thread-layout-proof',
        execution_id: 'exe_layout_proof',
        event_id: 1,
        atrium_ts: stamp,
      })}\n\n`,
    });
  });
  await page.goto(`/c/${roomId}?agent=${sessionId}`);
  await expect(page.getByRole('button', { name: 'Expand agent to focus view' })).toBeVisible();
}

test('left navigation owns its persisted desktop rail and mobile ignores the preference', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, unique('left-rail'), 'Left Rail Proof');

  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toHaveCSS('width', '224px');
  await attachScreenshot(page, testInfo, '01-wide-navigation');

  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  await expect(sidebar).toHaveCSS('width', '52px');
  await expect(page.getByTestId('sidebar-collapsed-rail')).toBeVisible();
  await expect(page.getByTestId('sidebar-collapsed-rail').getByRole('button', { name: /^Inbox/ })).toBeVisible();
  await expect(page.getByTestId('sidebar-collapsed-rail').getByRole('button', { name: 'Files' })).toBeVisible();
  await expect(page.getByTestId('sidebar-collapsed-rail').getByRole('button', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open agent dock/ })).toBeVisible();
  const agentOpener = await page.getByRole('button', { name: /Open agent dock/ }).boundingBox();
  expect(agentOpener?.y).toBeLessThan(24);
  await attachScreenshot(page, testInfo, '02-collapsed-navigation-and-top-anchored-agents');

  await page.reload();
  await expect(sidebar).toHaveCSS('width', '52px');
  await page.getByTestId('sidebar-collapsed-rail').getByRole('button', { name: 'Files' }).click();
  await expect(page.getByRole('heading', { name: /Files/ }).first()).toBeVisible();
  await attachScreenshot(page, testInfo, '03-collapsed-navigation-files-active');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(sidebar).toHaveCSS('width', '288px');
  await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeVisible();
  await attachScreenshot(page, testInfo, '04-mobile-navigation-ignores-desktop-collapse');
});

test('agent session header is the single split-focus control', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSessionProof(page);

  await expect(page.getByTestId('pane-resize-handle')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Layout' })).toHaveCount(0);
  await attachScreenshot(page, testInfo, '05-agent-split-view');

  await page.getByRole('button', { name: 'Expand agent to focus view' }).click();
  await expect(page).toHaveURL(/view=focus/);
  await expect(page.getByRole('button', { name: 'Return agent to split view' })).toBeVisible();
  await expect(page.getByTestId('pane-resize-handle')).toHaveCount(0);
  await attachScreenshot(page, testInfo, '06-agent-focus-view');

  await page.getByRole('button', { name: 'Return agent to split view' }).click();
  await expect(page).not.toHaveURL(/view=focus/);
  await expect(page.getByTestId('pane-resize-handle')).toBeVisible();
});
