import {
  expect,
  request,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { Pool, type PoolClient } from 'pg';

export const baseURL = `http://127.0.0.1:${Number(process.env.E2E_WEB_PORT ?? 5273)}`;
export const apiURL = `http://127.0.0.1:${Number(process.env.E2E_SERVER_PORT ?? 3101)}`;
export const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';
// Kept in step with the server's key by playwright.config.ts, which publishes it
// into the worker environment; the fallback only covers a bare `playwright test`.
const captureApiKey = process.env.ARTIFACT_CAPTURE_API_KEY ?? 'e2e-capture-key';

export async function seedEvent(
  client: PoolClient,
  args: {
    workspaceId: string;
    channelId: string;
    threadRootEventId?: number | null;
    type: string;
    actorId?: string | null;
    payload: unknown;
  },
): Promise<number> {
  const inserted = await client.query<{ id: string | number }>(
    `INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      args.workspaceId,
      args.channelId,
      args.threadRootEventId ?? null,
      args.type,
      args.actorId ?? null,
      JSON.stringify(args.payload),
    ],
  );
  const id = Number(inserted.rows[0]!.id);
  if (!Number.isSafeInteger(id)) throw new Error('seeded event did not return a numeric id');
  await client.query('SELECT project_message_event($1)', [id]);
  return id;
}

export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function uniqueChannel(prefix: string): string {
  const stem =
    prefix
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/-+$/g, '')
      .slice(0, 16) || 'room';
  const suffix = `${Date.now().toString(36).slice(-6)}-${Math.random().toString(36).slice(2, 7)}`;
  return `${stem}-${suffix}`.slice(0, 32);
}

export async function login(page: Page, handle: string, displayName = handle): Promise<void> {
  const response = await page.context().request.post('/auth/login', {
    data: { handle, displayName },
  });
  expect(response.ok(), `POST /auth/login (${response.status()})`).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible();
}

export async function loginViaForm(page: Page, handle: string, displayName = handle): Promise<void> {
  await page.goto('/');
  // Handle sign-in is the primary path when AUTH_OPEN is on (the e2e default):
  // the form is expanded by default (no "dev login" disclosure anymore).
  await page.getByPlaceholder('gary', { exact: true }).fill(handle);
  await page.getByPlaceholder('Gary Basin').fill(displayName);
  await page.getByRole('button', { name: 'Continue with a handle' }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible();
}

/** Open the configured spawn dialog through the composer's canonical agent path. */
export async function openConfiguredAgentDialog(page: Page, task = 'Configure an agent'): Promise<Locator> {
  const main = page.locator('#main-content');
  const audience = main.getByTestId('composer-audience-pill');
  if ((await audience.getAttribute('aria-checked')) !== 'true') await audience.click();
  await main.getByPlaceholder('Prompt agent…').fill(task);
  await main.getByRole('button', { name: 'Configure and start an agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function warmOfflineShell(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return;
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible();
}

/**
 * Cut the network only once the client is genuinely connected.
 *
 * Every offline test assumes the app is online before it goes offline, but none
 * of them used to prove it — and losing that race is silent. The app registers
 * its `offline` listener inside the useWs effect, so if the network is cut
 * before that effect mounts: the dispatched `offline` event fires into the void
 * (DOM events are not replayed), and Playwright's `setOffline` blocks traffic
 * without closing an already-open socket. The client therefore keeps believing
 * it is connected — no Reconnecting banner, no queue drain — until an idle timer
 * eventually notices, well past any assertion budget.
 *
 * On an idle box the effect has always mounted by now and the race is invisible.
 * Under CPU contention it is easy to lose, which is what made these tests look
 * flaky. Waiting for `connection: open` proves the socket opened, which proves
 * the effect ran, which proves the listener is registered.
 */
export async function goOffline(page: Page, context: BrowserContext, { signal = false } = {}): Promise<void> {
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible();
  await context.setOffline(true);
  // Chromium's Playwright offline emulation blocks traffic but does not fire the
  // page-level event the app receives from a real browser.
  if (signal) await page.evaluate(() => window.dispatchEvent(new Event('offline')));
}

export function mainComposer(page: Page, _channelName = 'general') {
  return page.locator('main').getByRole('combobox', { name: 'Message input' });
}

export async function sendMessage(page: Page, text: string, channelName = 'general'): Promise<void> {
  await mainComposer(page, channelName).fill(text);
  await mainComposer(page, channelName).press('Enter');
  // Wait for the server-confirmed row ([data-eid]), not just the optimistic
  // echo. Hover-revealed row actions are pointer-events-none until :hover, and
  // a row that settles under a stationary cursor between hover() and click()
  // never re-enters :hover — the click then dead-ends on the header line until
  // the test times out.
  await expect(confirmedRowsWithText(page, text).first()).toBeVisible();
}

export function messageRow(page: Page, text: string) {
  return page.locator('[data-eid]').filter({ hasText: text }).first();
}

export function confirmedRowsWithText(page: Page, text: string) {
  return page.getByRole('log', { name: 'Messages' }).locator('[data-eid]').filter({ hasText: text });
}

export function timelineText(page: Page, text: string) {
  return page.getByRole('log', { name: 'Messages' }).getByText(text, { exact: true });
}

export async function messageId(page: Page, text: string): Promise<number> {
  await expect(messageRow(page, text)).toBeVisible();
  const raw = await messageRow(page, text).getAttribute('data-eid');
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw new Error(`message has no confirmed event id: ${text}`);
  return id;
}

export function channelButton(page: Page, channelName: string) {
  // Anchored at the start: each sidebar row also has a "Mute <name>" button
  // whose accessible name would match a loose substring regex.
  return page.getByRole('button', { name: new RegExp(`^#?\\s*${channelName}(\\s|$|unread)`) });
}

function unreadMarker(page: Page, channelName: string) {
  return channelButton(page, channelName)
    .locator('span.sr-only')
    .filter({ hasText: /^unread$/ });
}

// Unread/read state arrives either via a live WS event or — deterministically —
// via the channel refetch on reload (channels carry latest/last-read cursors).
// CI's runners are slow and the vite WS proxy can drop a socket under load, so
// after a short live window we reload to force the deterministic path. The live
// delivery itself is covered by the realtime test.
export async function expectUnread(page: Page, channelName: string): Promise<void> {
  const marker = unreadMarker(page, channelName);
  try {
    await expect(marker).toHaveCount(1, { timeout: 4000 });
  } catch {
    await page.reload();
    await expect(marker).toHaveCount(1, { timeout: 20_000 });
  }
}

export async function expectRead(page: Page, channelName: string): Promise<void> {
  const marker = unreadMarker(page, channelName);
  try {
    await expect(marker).toHaveCount(0, { timeout: 4000 });
  } catch {
    await page.reload();
    await expect(marker).toHaveCount(0, { timeout: 20_000 });
  }
}

export async function openChannel(page: Page, channelName: string): Promise<void> {
  await channelButton(page, channelName).click();
  await expect(page.getByRole('heading', { name: `# ${channelName}` })).toBeVisible();
}

export async function apiAs(handle: string, displayName = handle): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: apiURL });
  const res = await ctx.post('/auth/login', { data: { handle, displayName } });
  expect(res.ok()).toBeTruthy();
  return ctx;
}

export async function createChannel(ctx: APIRequestContext, name: string): Promise<string> {
  const res = await ctx.post('/api/channels', { data: { name } });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { channel: { id: string } };
  return body.channel.id;
}

export async function createTestChannel(prefix = 'room'): Promise<string> {
  const setup = await apiAs(unique('setup'), 'Setup');
  try {
    const name = uniqueChannel(prefix);
    await createChannel(setup, name);
    return name;
  } finally {
    await setup.dispose();
  }
}

async function channels(ctx: APIRequestContext): Promise<Array<{ id: string; name: string }>> {
  const res = await ctx.get('/api/channels');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { channels: Array<{ id: string; name: string }> };
  return body.channels;
}

export async function channelId(ctx: APIRequestContext, name: string): Promise<string> {
  const found = (await channels(ctx)).find((c) => c.name === name);
  if (!found) throw new Error(`channel not found: ${name}`);
  return found.id;
}

export async function postMessage(ctx: APIRequestContext, channelIdValue: string, text: string): Promise<number> {
  const res = await ctx.post('/api/messages', {
    data: { channelId: channelIdValue, text, clientMsgId: unique('api-msg') },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { event: { id: number } };
  return body.event.id;
}

/** Persist a user's read cursor directly in the e2e database. */
export async function setReadCursor(args: {
  handle: string;
  channelId: string;
  lastReadEventId: number;
}): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [args.handle]);
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error(`missing e2e user: ${args.handle}`);
    await client.query(
      `INSERT INTO channel_read_cursors (user_id, channel_id, last_read_event_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, channel_id)
       DO UPDATE SET last_read_event_id = EXCLUDED.last_read_event_id,
                     updated_at = now()`,
      [userId, args.channelId, args.lastReadEventId],
    );
  } finally {
    client.release();
    await pool.end();
  }
}

/** Read a user's current persisted channel cursor from the e2e database. */
export async function readCursor(args: { handle: string; channelId: string }): Promise<number> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    const result = await client.query<{ last_read_event_id: string | number }>(
      `SELECT rc.last_read_event_id
       FROM channel_read_cursors rc
       JOIN users u ON u.id = rc.user_id
       WHERE u.handle = $1 AND rc.channel_id = $2`,
      [args.handle, args.channelId],
    );
    return Number(result.rows[0]?.last_read_event_id ?? 0);
  } finally {
    client.release();
    await pool.end();
  }
}

/** Seed a numbered message sequence, optionally with custom text or parallel requests. */
export async function seedMessages(
  ctx: APIRequestContext,
  channelIdValue: string,
  prefix: string,
  count: number,
  options: { parallel?: boolean; text?: (index: number, prefix: string) => string } = {},
): Promise<number[]> {
  const text = options.text ?? ((index: number, value: string) => `${value} ${index}`);
  if (options.parallel) {
    return Promise.all(
      Array.from({ length: count }, (_, index) => postMessage(ctx, channelIdValue, text(index + 1, prefix))),
    );
  }

  const ids: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    ids.push(await postMessage(ctx, channelIdValue, text(index, prefix)));
  }
  return ids;
}

/** Measure the remaining scroll distance below a timeline viewport. */
export async function distanceFromBottom(log: Locator): Promise<number> {
  return log.evaluate((node) => {
    const element = node as HTMLElement;
    return element.scrollHeight - element.scrollTop - element.clientHeight;
  });
}

/** Scroll a timeline to its bottom and dispatch the matching scroll event. */
export async function scrollToBottom(log: Locator, options: { bubbles?: boolean } = {}): Promise<void> {
  await log.evaluate((node, bubbles) => {
    const element = node as HTMLElement;
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll', { bubbles }));
  }, options.bubbles ?? true);
}

/** Assert that an unread divider lies within its timeline viewport. */
export async function expectDividerInTimelineViewport(divider: Locator): Promise<void> {
  await expect
    .poll(async () =>
      divider.evaluate((node) => {
        const scroller = node.closest('[role="log"]');
        if (!scroller) return false;
        const rect = node.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        return rect.top >= bounds.top - 2 && rect.top <= bounds.bottom + 2;
      }),
    )
    .toBe(true);
}

/** Measure an unread divider's offset from the top of its timeline viewport. */
export async function dividerOffsetFromViewportTop(divider: Locator): Promise<number> {
  return divider.evaluate((node) => {
    const scroller = node.closest('[role="log"]');
    if (!scroller) return Number.POSITIVE_INFINITY;
    return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
}

/** Warm and reload a reader's cached bottom position after its cursor is confirmed. */
export async function warmReaderCache(args: {
  page: Page;
  room: string;
  latestEventId: number;
  readCursor: () => Promise<number>;
  confirmBottomBeforeCursor?: boolean;
  confirmBottomAfterReload?: boolean;
  cursorPollOptions?: { intervals?: number[]; timeout?: number };
}): Promise<string> {
  const log = args.page.getByRole('log', { name: 'Messages' });
  const latestRow = log.locator(`[data-eid="${args.latestEventId}"]`);
  await latestRow.scrollIntoViewIfNeeded();
  await expect(latestRow).toBeVisible();
  if (args.confirmBottomBeforeCursor) {
    await expect.poll(() => distanceFromBottom(log), { timeout: 20_000 }).toBeLessThan(8);
  }
  await expect.poll(args.readCursor, args.cursorPollOptions).toBeGreaterThanOrEqual(args.latestEventId);

  const route = args.page.url();
  await args.page.reload();
  await expect(args.page.getByRole('heading', { name: `# ${args.room}` })).toBeVisible();
  await expect(log.locator(`[data-eid="${args.latestEventId}"]`)).toBeVisible({ timeout: 20_000 });
  if (args.confirmBottomAfterReload ?? true) {
    await expect.poll(() => distanceFromBottom(log), { timeout: 20_000 }).toBeLessThan(8);
  }
  return route;
}

export async function injectSession(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<{ rootId: number; sessionId: string }> {
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
       VALUES ($1, $2, $3, 'codex', $4, 'running', $5, $5, 'exe_e2e_spine', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('spine')}`, args.title, userId],
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
    return { rootId, sessionId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function injectSessionReply(args: {
  channelId: string;
  rootId: number;
  sessionId: string;
  text: string;
}): Promise<number> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const channel = await client.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
      args.channelId,
    ]);
    if (!channel.rows[0]) throw new Error('missing e2e channel');
    const replyId = await seedEvent(client, {
      workspaceId: channel.rows[0].workspace_id,
      channelId: args.channelId,
      threadRootEventId: args.rootId,
      type: 'session.replied',
      actorId: null,
      payload: { session_id: args.sessionId, text: args.text, broadcast: true },
    });
    // The answer implies the turn ended: mark the session terminal so the slot
    // renders the anchored answer instead of a working strip (a running session
    // deliberately withholds its claimed answer).
    await client.query(`UPDATE sessions SET status = 'completed', completed_at = now() WHERE id = $1`, [
      args.sessionId,
    ]);
    await client.query('COMMIT');
    return replyId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Seed a human steer: a thread-rooted message.posted carrying steered_session_id
// (the exact shape the server writes for POST /api/sessions/:id/messages). Used
// to assert steers interleave with agent responses in the channel cluster.
export async function injectSteer(args: {
  handle: string;
  channelId: string;
  rootId: number;
  sessionId: string;
  text: string;
}): Promise<number> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [args.handle]);
    const channel = await client.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
      args.channelId,
    ]);
    if (!user.rows[0] || !channel.rows[0]) throw new Error('missing e2e user or channel');
    const steerId = await seedEvent(client, {
      workspaceId: channel.rows[0].workspace_id,
      channelId: args.channelId,
      threadRootEventId: args.rootId,
      type: 'message.posted',
      actorId: user.rows[0].id,
      payload: { text: args.text, steered_session_id: args.sessionId },
    });
    await client.query('COMMIT');
    return steerId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

export function sseFrame(event: string, eventId: number, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ ...data, event_id: eventId })}\n\n`;
}

export async function injectSessionWork(
  page: Page,
  args: {
    sessionId: string;
    sideEffects?: number;
    files?: number;
    replyText?: string;
  },
): Promise<void> {
  const sideEffectCount = Math.max(0, Math.trunc(args.sideEffects ?? 0));
  const fileCount = Math.max(0, Math.trunc(args.files ?? 0));
  const stamp = new Date().toISOString();
  let eventId = 1;
  const frames = [
    sseFrame('execution_state', eventId, {
      type: 'execution.state',
      status: 'running',
      thread_key: `thread-${args.sessionId}`,
      execution_id: `exe-e2e-${args.sessionId}`,
      atrium_ts: stamp,
    }),
  ];

  for (let index = 1; index <= sideEffectCount; index += 1) {
    eventId += 1;
    frames.push(
      sseFrame('amp_raw_event', eventId, {
        type: 'assistant',
        uuid: `assistant-work-${index}`,
        message: {
          id: `message-work-${index}`,
          content: [
            {
              type: 'tool_use',
              id: `tool-work-${index}`,
              name: 'Bash',
              input: { command: `echo step ${index}` },
            },
          ],
        },
        atrium_ts: stamp,
      }),
    );
  }

  for (let index = 1; index <= fileCount; index += 1) {
    eventId += 1;
    frames.push(
      sseFrame('amp_raw_event', eventId, {
        type: 'item.completed',
        item: {
          id: `file-change-${index}`,
          type: 'fileChange',
          changes: [
            {
              path: `/home/agent/workspace/fixture-${index}.ts`,
              kind: 'update',
              diff: `@@\n-old step ${index}\n+new step ${index}`,
            },
          ],
        },
        atrium_ts: stamp,
      }),
    );
  }

  if (args.replyText != null) {
    eventId += 1;
    frames.push(
      sseFrame('amp_raw_event', eventId, {
        type: 'item.completed',
        item: { id: 'agent-work-reply', type: 'agentMessage', text: args.replyText },
        atrium_ts: stamp,
      }),
    );
  }

  eventId += 1;
  frames.push(
    sseFrame('execution_state', eventId, {
      type: 'execution.state',
      status: 'completed',
      thread_key: `thread-${args.sessionId}`,
      execution_id: `exe-e2e-${args.sessionId}`,
      ...(args.replyText != null ? { result_text: args.replyText } : {}),
      atrium_ts: stamp,
    }),
  );

  await page.route(`**/api/sessions/${args.sessionId}/stream*`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: frames.join(''),
    });
  });
}

// === mw78-overflow additions ===
export async function uploadViaApi(
  ctx: APIRequestContext,
  filename: string,
  contentType: string,
  bytes: Buffer,
  dimensions?: { width?: number; height?: number },
): Promise<string> {
  const { createHash } = await import('node:crypto');
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const created = await ctx.post('/api/uploads', {
    data: {
      filename,
      contentType,
      size: bytes.byteLength,
      contentHash,
      ...(dimensions?.width != null ? { width: dimensions.width } : {}),
      ...(dimensions?.height != null ? { height: dimensions.height } : {}),
    },
  });
  expect(created.ok(), `POST /api/uploads (${created.status()})`).toBeTruthy();
  const { fileId, uploadUrl } = (await created.json()) as { fileId: string; uploadUrl: string };
  const put = await ctx.put(uploadUrl, {
    headers: { 'content-type': contentType },
    data: bytes,
  });
  expect(put.ok(), `presigned PUT to storage (${put.status()})`).toBeTruthy();
  return fileId;
}

export async function postWithAttachment(
  ctx: APIRequestContext,
  channelIdValue: string,
  text: string,
  fileId: string,
): Promise<number> {
  const res = await ctx.post('/api/messages', {
    data: {
      channelId: channelIdValue,
      text,
      attachments: [fileId],
      clientMsgId: unique('api-att'),
    },
  });
  expect(res.ok(), `POST /api/messages with attachment (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as { event: { id: number } };
  return body.event.id;
}

/**
 * A live session blocked on a consequential question, injected straight into
 * the database (the harness has no real agent to ask one). Shared by the
 * question specs: the "heals without reload" catch-up path and the answer/undo
 * path both need exactly this state.
 */
export const questionPrompts = [
  {
    id: 'choice',
    header: 'Decision',
    question: 'Which deployment path should I take?',
    options: [
      { label: 'Fast', description: 'Ship the smallest change' },
      { label: 'Careful', description: 'Run the full suite first' },
    ],
  },
];

export const QUESTION_ID = 'q-main';

export async function injectQuestionRequested(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<{ rootId: number; sessionId: string; questionText: string }> {
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
       VALUES ($1, $2, $3, 'claude-code', $4, 'running', $5, $5, 'exe_e2e_question', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('question')}`, args.title, userId],
    );
    const sessionId = session.rows[0]!.id;
    const rootId = await seedEvent(client, {
      workspaceId,
      channelId: args.channelId,
      type: 'session.spawned',
      actorId: userId,
      payload: {
        sessionId,
        title: args.title,
        harness: 'claude-code',
        by: userId,
      },
    });
    const pendingQuestion = {
      questionId: QUESTION_ID,
      turnId: 'turn-1',
      eventId: 1,
      questions: questionPrompts,
    };
    await client.query(
      `UPDATE sessions
       SET thread_root_event_id = $1,
           pending_question = $2,
           last_event_id = GREATEST(last_event_id, $3)
       WHERE id = $4`,
      [rootId, JSON.stringify(pendingQuestion), pendingQuestion.eventId, sessionId],
    );
    await seedEvent(client, {
      workspaceId,
      channelId: args.channelId,
      threadRootEventId: rootId,
      type: 'session.question_requested',
      actorId: userId,
      payload: {
        sessionId,
        questionId: pendingQuestion.questionId,
        questions: questionPrompts,
        permalink: `/s/${sessionId}`,
      },
    });
    await client.query('COMMIT');
    return { rootId, sessionId, questionText: questionPrompts[0]!.question };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

/** What the server actually recorded for a session's question. */
export async function questionState(sessionId: string): Promise<{
  pendingQuestionId: string | null;
  answeredQuestion: { questionId: string; answeredByName: string; answerText: string } | null;
  answeredEventCount: number;
}> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  try {
    const row = await pool.query<{
      pending_question: { questionId?: string } | null;
      answered_question: { questionId: string; answeredByName: string; answerText: string } | null;
    }>('SELECT pending_question, answered_question FROM sessions WHERE id = $1', [sessionId]);
    const events = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events
       WHERE type = 'session.question_answered' AND payload->>'sessionId' = $1`,
      [sessionId],
    );
    return {
      pendingQuestionId: row.rows[0]?.pending_question?.questionId ?? null,
      answeredQuestion: row.rows[0]?.answered_question ?? null,
      answeredEventCount: Number(events.rows[0]?.count ?? '0'),
    };
  } finally {
    await pool.end();
  }
}

/**
 * Seeds a real artifact with real bytes.
 *
 * This goes through the node capture endpoint rather than inserting rows: that
 * is the same path node-sync uses, so the artifact lands in CAS and the ledger
 * exactly like a captured one, and `/api/files/artifact/:id/content` serves it
 * for real. Hand-built rows would drift from the write path and pass while the
 * product broke. Capture is session-scoped, so a throwaway session is created
 * to own the write unless one is supplied.
 *
 * The path must be canonically shared (`shared/channels/<id>/…`) for a reader
 * to see it — a `scratch/<session>/…` artifact is private to that session.
 */
export async function seedArtifact(args: {
  channelId: string;
  body: string;
  path?: string;
  mime?: string;
  sessionId?: string;
}): Promise<{ artifactId: string; handle: string; path: string; seq: number }> {
  const path = args.path ?? `shared/channels/${args.channelId}/${unique('seeded')}.md`;
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  try {
    const sessionId = args.sessionId ?? (await createCaptureSession(pool, args.channelId));
    const ctx = await request.newContext({ baseURL: apiURL });
    try {
      const res = await ctx.post(
        `/api/internal/sessions/${sessionId}/artifacts/capture?path=${encodeURIComponent(path)}`,
        {
          headers: {
            // Published by playwright.config.ts, which starts the server with the
            // same value — so this cannot drift into a 401.
            'x-api-key': captureApiKey,
            'content-type': args.mime ?? 'text/markdown',
          },
          data: args.body,
        },
      );
      if (!res.ok()) throw new Error(`capture failed (${res.status()}): ${await res.text()}`);
      const { seq } = (await res.json()) as { seq: number };
      const row = await pool.query<{ id: string }>(
        'SELECT id FROM artifacts WHERE channel_id = $1 AND path = $2 ORDER BY created_at DESC LIMIT 1',
        [args.channelId, path],
      );
      const artifactId = row.rows[0]?.id;
      if (!artifactId) throw new Error(`captured artifact not found for path ${path}`);
      return { artifactId, handle: `art_${artifactId}`, path, seq };
    } finally {
      await ctx.dispose();
    }
  } finally {
    await pool.end();
  }
}

/** A minimal session for capture to write through; the harness never runs it. */
async function createCaptureSession(pool: Pool, channelIdValue: string): Promise<string> {
  const channel = await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
    channelIdValue,
  ]);
  const workspaceId = channel.rows[0]?.workspace_id;
  if (!workspaceId) throw new Error(`no such channel: ${channelIdValue}`);
  // `spawned_by` is a NOT NULL reference to a real user, so the session is
  // owned by a member of the channel's own workspace rather than any user
  // that happens to exist.
  const owner = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM workspace_members WHERE workspace_id = $1 ORDER BY user_id LIMIT 1',
    [workspaceId],
  );
  const ownerId = owner.rows[0]?.user_id;
  if (!ownerId) throw new Error(`workspace ${workspaceId} has no members to own a capture session`);
  // `cancelled`, because this session exists only to authorize the write and is never
  // run — claiming `running` would be a lie the product reads. Every e2e user shares one
  // default workspace and the sidebar groups running sessions across it, so a seed stuck
  // at `running` forever is a phantom agent row other specs can see. (No existing spec
  // was observed to fail on it — they assert on their own titles, not on counts — so
  // this is hygiene against a future count-based assertion, not a fix for a known flake.)
  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions (
       workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id,
       assignment_generation
     )
     VALUES ($1, $2, $3, 'codex', $4, 'cancelled', $5, $5, 1)
     RETURNING id`,
    [workspaceId, channelIdValue, `thread-${unique('seed-artifact')}`, unique('artifact-seed'), ownerId],
  );
  return session.rows[0]!.id;
}
