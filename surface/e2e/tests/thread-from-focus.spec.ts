// Opening the origin thread from a full-screen (focused) agent view must not
// blank the panel. Regression: deep-diving straight into a focused agent left
// the channel timeline as the only source for the thread root; while (or if)
// the root wasn't resolvable in `timeline.main`, ConversationPanel rendered
// its session body `hidden` in thread mode — a blank screen.

import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { channelId, createTestChannel, login, seedEvent, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

/** Seed a running session bound to the channel (mirrors session-pane-ux.spec's helper). */
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
       VALUES ($1, $2, $3, 'claude-code', $4, 'running', $5, $5, 'exe_e2e_tff', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('tff')}`, args.title, userId],
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

async function stubSessionStream(page: Page): Promise<void> {
  const stamp = new Date().toISOString();
  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body:
        sseFrame('execution_state', 1, {
          type: 'execution.state',
          status: 'running',
          thread_key: 'thread-e2e-tff',
          execution_id: 'exe_e2e_tff',
          atrium_ts: stamp,
        }) +
        sseFrame('amp_raw_event', 2, {
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
}

test('thread crumb from a deep-loaded focused agent opens the thread instead of blanking', async ({ page }) => {
  const room = await createTestChannel('tff');
  const handle = unique('tff');
  await login(page, handle, 'Thread From Focus');
  const roomId = await channelId(page.context().request, room);
  const sessionId = await injectSession({ handle, channelId: roomId, title: unique('tff-session') });

  await stubSessionStream(page);
  // Deep-dive straight into the focused agent — the channel timeline has never
  // been rendered in this tab.
  await page.goto(`/s/${sessionId}`);
  await expect(page.getByTestId('user-steer')).toBeVisible();

  // The origin crumb line: "#channel ▸ thread ▸ work". Click the thread crumb.
  const crumb = page.getByTestId('conversation-crumb');
  await expect(crumb).toBeVisible();
  await crumb.getByRole('button', { name: 'thread', exact: true }).click();

  // The thread panel must appear...
  await expect(page.getByRole('button', { name: 'Close thread' })).toBeVisible({ timeout: 10_000 });
  // ...and the channel MAIN must come back beside it. The focused agent keeps
  // its session selected across the zoom-out; that must not hold the layout in
  // focus view (which unmounted the channel and left the thread panel floating
  // beside a blank).
  await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
  // The channel timeline itself is rendered (the session's summon row).
  await expect(page.getByText('Open thread →')).toBeVisible();
});
