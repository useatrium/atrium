import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { baseURL, channelId, createTestChannel, login, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

async function injectSession(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<{ sessionId: string; entryHandle: string; entryText: string }> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  const threadKey = `thread-${unique('transcript-sheet')}`;
  const entryUid = `e2e-sheet-${unique('record')}`;
  const entryHandle = `rec_${entryUid}`;
  const itemId = `agent-${unique('sheet-item')}`;
  const entryText = 'Browser E2E transcript action sheet target.';
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
       VALUES ($1, $2, $3, 'codex', $4, 'running', $5, $5, 'exe_e2e_transcript_sheet', 1)
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

async function gotoInjectedTranscript(page: Page): Promise<{
  sessionId: string;
  entryHandle: string;
  entryText: string;
}> {
  const room = await createTestChannel('transcript-sheet');
  const handle = unique('transcript-sheet');
  await login(page, handle, 'Transcript Sheet');
  const roomId = await channelId(page.context().request, room);
  const injected = await injectSession({
    handle,
    channelId: roomId,
    title: unique('transcript-sheet-title'),
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
          thread_key: `thread-${injected.sessionId}`,
          execution_id: 'exe_e2e_transcript_sheet',
          atrium_ts: stamp,
        }) +
        sseFrame('amp_raw_event', 2, {
          type: 'item.completed',
          item: { id: `agent-${injected.entryHandle}`, type: 'agentMessage', text: injected.entryText },
          recordHandles: [
            {
              handle: injected.entryHandle,
              kind: 'message',
              actor: 'agent',
              meta: {
                itemId: `agent-${injected.entryHandle}`,
                messageId: `agent-${injected.entryHandle}`,
              },
            },
          ],
          atrium_ts: stamp,
        }),
    });
  });

  await page.goto(`/s/${injected.sessionId}`);
  await expect(page.locator(`[data-entry-handle="${injected.entryHandle}"]`)).toBeVisible();
  await expect(page.getByText(injected.entryText, { exact: true })).toBeVisible();
  return injected;
}

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

test('transcript action sheet opens on touch without resting action-bar clutter', async ({ context, page }) => {
  const { entryHandle, entryText } = await gotoInjectedTranscript(page);
  const transcriptRow = page.locator(`[data-entry-handle="${entryHandle}"]`);
  const actionBar = transcriptRow.locator('[data-testid="transcript-entry-action-bar"]');

  // Touch devices don't render the inline action bar at all (even opacity-0
  // would reserve flex space and misplace the tap-revealed ⋯).
  await expect(actionBar).toHaveCount(0);
  await expect(transcriptRow.getByRole('button', { name: 'Copy entry link' })).toHaveCount(0);
  await expect(transcriptRow.getByRole('button', { name: 'More transcript actions' })).toHaveCount(0);

  await transcriptRow.tap({ position: { x: 24, y: 18 } });
  await expect(transcriptRow.getByRole('button', { name: 'More transcript actions' })).toBeVisible();

  // Dismiss by tapping outside the entry (the touch path; Escape would close
  // the whole pane via the global shortcut registry in Chat.tsx).
  const rowBoxForDismiss = await transcriptRow.boundingBox();
  if (!rowBoxForDismiss) throw new Error('transcript row did not lay out');
  await page.touchscreen.tap(
    rowBoxForDismiss.x + rowBoxForDismiss.width / 2,
    rowBoxForDismiss.y + rowBoxForDismiss.height + 60,
  );
  await expect(transcriptRow.getByRole('button', { name: 'More transcript actions' })).toHaveCount(0);

  await transcriptRow.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const box = await transcriptRow.boundingBox();
  if (!box) throw new Error('transcript row did not lay out');
  const x = Math.min(box.x + box.width - 16, box.x + 96);
  const y = Math.min(box.y + box.height - 12, Math.max(box.y + 12, 610));
  const cdp = await context.newCDPSession(page);

  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }],
    });
    await page.waitForTimeout(700);

    const dialog = page.getByRole('dialog', { name: 'Message actions' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy entry link' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy block text' })).toBeVisible();
    await expect(dialog.getByText(entryText, { exact: true })).toHaveCount(0);

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copied entry link' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copied block text' })).toHaveCount(0);
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {});
    await cdp.detach();
  }
});

// "Select text…" (touch-only, #341 menu): transcript rows have no raw
// markdown, so the sheet shows the rendered DOM's innerText — same source as
// Copy block text.
test('Select text opens a selectable sheet with the transcript entry text', async ({ context, page }) => {
  const { entryHandle, entryText } = await gotoInjectedTranscript(page);
  const transcriptRow = page.locator(`[data-entry-handle="${entryHandle}"]`);
  await transcriptRow.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const box = await transcriptRow.boundingBox();
  if (!box) throw new Error('transcript row did not lay out');
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: box.x + 40, y: box.y + box.height / 2, id: 1 }],
    });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {});
    await cdp.detach();
  }

  const menu = page.getByRole('dialog', { name: 'Message actions' });
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: 'Select text…' }).tap();

  const sheet = page.getByRole('dialog', { name: 'Select text' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(entryText, { exact: true })).toBeVisible();
  const content = sheet.getByTestId('select-text-content');
  expect(await content.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe('none');

  await sheet.getByRole('button', { name: 'Done' }).tap();
  await expect(sheet).toHaveCount(0);
});

// Transcript entries used to preventDefault() right-click to show our own menu,
// swallowing the browser's (Copy on a selection, Open link in new tab, …). The
// action list now lives behind a visible ⋯ button, so right-click is the
// browser's again. Playwright cannot see the native menu, so assert the cause:
// the contextmenu event must reach the document uncancelled.
test.describe('pointer devices', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 800 } });

  test('right-click on a transcript entry leaves the native menu to the browser', async ({ page }) => {
    const { entryHandle } = await gotoInjectedTranscript(page);

    await page.evaluate(() => {
      const w = window as typeof window & { __ctxPrevented?: boolean };
      delete w.__ctxPrevented;
      document.addEventListener(
        'contextmenu',
        (event) => {
          w.__ctxPrevented = event.defaultPrevented;
        },
        { once: true },
      );
    });
    await page.locator(`[data-entry-handle="${entryHandle}"]`).click({ button: 'right' });

    await expect
      .poll(() => page.evaluate(() => (window as typeof window & { __ctxPrevented?: boolean }).__ctxPrevented))
      .toBe(false);
    await expect(page.getByRole('dialog', { name: 'Message actions' })).toHaveCount(0);
  });

  test('the transcript overflow button still exposes every entry action', async ({ page }) => {
    const { entryHandle } = await gotoInjectedTranscript(page);
    const row = page.locator(`[data-entry-handle="${entryHandle}"]`);
    await row.hover();
    await row.getByRole('button', { name: 'More transcript actions' }).click();

    const menu = page.getByRole('dialog', { name: 'Message actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Copy entry link' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Select text…' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Discuss in thread' })).toBeVisible();
  });
});
