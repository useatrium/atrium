// Session-pane UX: per-turn hover timestamps (server-stamped SSE frames) and
// the drag-resizable, persisted split-view pane width. Real-browser coverage
// for the seams jsdom can't exercise: PointerEvent capture during drag and the
// wire-format agreement on `atrium_ts`.

import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { channelId, createTestChannel, login, seedEvent, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

/** Seed a running session bound to the channel (mirrors chat.spec's helper). */
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
       VALUES ($1, $2, $3, 'claude-code', $4, 'running', $5, $5, 'exe_e2e_ux', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('ux')}`, args.title, userId],
    );
    const sessionId = session.rows[0]!.id;
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

async function openSeededSession(page: Page, prefix: string, includeWork = false): Promise<void> {
  const room = await createTestChannel(prefix);
  const handle = unique(prefix);
  await login(page, handle, 'Ux Tester');
  const roomId = await channelId(page.context().request, room);
  const sessionId = await injectSession({ handle, channelId: roomId, title: unique('ux-session') });

  const stamp = new Date().toISOString();
  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body:
        sseFrame('execution_state', 1, {
          type: 'execution.state',
          status: 'running',
          thread_key: 'thread-e2e-ux',
          execution_id: 'exe_e2e_ux',
          atrium_ts: stamp,
        }) +
        (includeWork
          ? sseFrame('amp_raw_event', 2, {
              type: 'assistant',
              uuid: 'assistant-focus-1',
              message: {
                id: 'message-focus-1',
                content: [
                  {
                    id: 'tool-focus-1',
                    type: 'tool_use',
                    name: 'Bash',
                    input: { command: 'echo focus-mode' },
                  },
                ],
              },
              atrium_ts: stamp,
            })
          : '') +
        // Close the turn with an assistant answer so the work above it is a
        // COMPLETED fold (live turns deliberately stream open, not collapsed).
        (includeWork
          ? sseFrame('amp_raw_event', 3, {
              type: 'assistant',
              uuid: 'assistant-focus-2',
              message: {
                id: 'message-focus-2',
                content: [{ type: 'text', text: 'Focus check complete.' }],
              },
              atrium_ts: stamp,
            })
          : '') +
        sseFrame('amp_raw_event', includeWork ? 4 : 2, {
          type: 'item.completed',
          item: {
            id: 'steer-1',
            type: 'userMessage',
            content: [{ type: 'text', text: 'please fix the parser' }],
          },
          atrium_ts: stamp,
        }),
    });
  });
  await page.goto(`/s/${sessionId}`);
  await expect(page.getByTestId('user-steer')).toBeVisible();
}

test('work folds collapse completed turns and the persisted expand-all restores them open', async ({ page }) => {
  await openSeededSession(page, 'transcript-focus', true);

  // Completed turns fold by default; the chip opens the step rows in place.
  const fold = page.getByTestId('work-fold-collapsed');
  await expect(fold).toHaveText(/1 step/);

  await fold.click();
  await expect(page.getByTestId('work-fold-expanded')).toBeVisible();

  // Expand-all lives behind the header overflow menu and persists.
  await page.getByRole('button', { name: 'Agent actions' }).click();
  await page.getByRole('button', { name: 'Expand all work' }).click();
  await page.reload();

  await expect(page.getByTestId('work-fold-expanded')).toBeVisible();
  // The persisted preference flips the menu action to collapse.
  await page.getByRole('button', { name: 'Agent actions' }).click();
  await expect(page.getByRole('button', { name: 'Collapse all work' })).toBeVisible();
});

test('transcript turns show a wall-clock timestamp on hover', async ({ page }) => {
  await openSeededSession(page, 'turntime');

  const steer = page.getByTestId('user-steer');
  const time = page.getByTestId('turn-time');
  // Revealed on hover (opacity transition), populated from the frame stamp.
  await steer.hover();
  await expect(time).toBeVisible();
  await expect(time).toHaveText(/\d{1,2}:\d{2}/);
});

test('session pane resizes by dragging its left edge and the width persists across reload', async ({ page }) => {
  await openSeededSession(page, 'resize');

  const handle = page.getByTestId('pane-resize-handle');
  await expect(handle).toBeVisible();
  const pane = page.locator('aside').filter({ has: handle });
  const before = (await pane.boundingBox())!;

  // Drag the handle 120px left → pane 120px wider (anchored right).
  const box = (await handle.boundingBox())!;
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX - 120, y, { steps: 6 });
  await page.mouse.up();

  const after = (await pane.boundingBox())!;
  expect(Math.round(after.width - before.width)).toBe(120);

  // Persisted: a fresh load opens at the dragged width.
  await page.reload();
  await expect(page.getByTestId('user-steer')).toBeVisible();
  const reloaded = (await page
    .locator('aside')
    .filter({ has: page.getByTestId('pane-resize-handle') })
    .boundingBox())!;
  expect(Math.round(reloaded.width)).toBe(Math.round(after.width));
});

test('undragged pane keeps the adaptive default on narrow desktop windows', async ({ page }) => {
  // 900px is non-mobile (≥768) → split view. With no stored width the pane
  // must scale with the viewport (min(520px, 42vw) = 378), not sit at 520px.
  await page.setViewportSize({ width: 900, height: 700 });
  await openSeededSession(page, 'narrow');

  const handle = page.getByTestId('pane-resize-handle');
  await expect(handle).toBeVisible();
  const pane = (await page.locator('aside').filter({ has: handle }).boundingBox())!;
  expect(Math.round(pane.width)).toBe(Math.round(900 * 0.42));
});
