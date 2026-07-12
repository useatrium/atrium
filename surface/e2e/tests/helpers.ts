import { expect, request, type APIRequestContext, type Page } from '@playwright/test';

export const baseURL = `http://127.0.0.1:${Number(process.env.E2E_WEB_PORT ?? 5273)}`;
export const apiURL = `http://127.0.0.1:${Number(process.env.E2E_SERVER_PORT ?? 3101)}`;

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
  const suffix = `${Date.now().toString(36).slice(-6)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
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

export async function loginViaForm(
  page: Page,
  handle: string,
  displayName = handle,
): Promise<void> {
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
  return channelButton(page, channelName).locator('span.sr-only').filter({ hasText: /^unread$/ });
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

export async function postMessage(
  ctx: APIRequestContext,
  channelIdValue: string,
  text: string,
): Promise<number> {
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
