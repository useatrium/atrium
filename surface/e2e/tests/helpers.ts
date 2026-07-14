import { expect, request, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { Pool } from 'pg';

export const baseURL = `http://127.0.0.1:${Number(process.env.E2E_WEB_PORT ?? 5273)}`;
export const apiURL = `http://127.0.0.1:${Number(process.env.E2E_SERVER_PORT ?? 3101)}`;
export const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

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

export function mainComposer(page: Page, channelName = 'general') {
  return page.getByPlaceholder(`Message #${channelName}`);
}

export async function sendMessage(page: Page, text: string, channelName = 'general'): Promise<void> {
  await mainComposer(page, channelName).fill(text);
  await mainComposer(page, channelName).press('Enter');
  await expect(page.getByText(text, { exact: true })).toBeVisible();
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
    const root = await client.query<{ id: string }>(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       VALUES ($1, $2, 'session.spawned', $3, $4)
       RETURNING id`,
      [
        workspaceId,
        args.channelId,
        userId,
        JSON.stringify({
          sessionId,
          title: args.title,
          harness: 'claude-code',
          by: userId,
        }),
      ],
    );
    const rootId = Number(root.rows[0]!.id);
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
    await client.query(
      `INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload)
       VALUES ($1, $2, $3, 'session.question_requested', $4, $5)`,
      [
        workspaceId,
        args.channelId,
        rootId,
        userId,
        JSON.stringify({
          sessionId,
          questionId: pendingQuestion.questionId,
          questions: questionPrompts,
          permalink: `/s/${sessionId}`,
        }),
      ],
    );
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
