import { expect, request, type APIRequestContext, type Page } from '@playwright/test';

export const baseURL = `http://127.0.0.1:${Number(process.env.E2E_WEB_PORT ?? 5273)}`;
export const apiURL = `http://127.0.0.1:${Number(process.env.E2E_SERVER_PORT ?? 3101)}`;

export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function login(page: Page, handle: string, displayName = handle): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder('gary', { exact: true }).fill(handle);
  await page.getByPlaceholder('Gary Basin').fill(displayName);
  await page.getByRole('button', { name: 'Join' }).click();
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

export async function channels(ctx: APIRequestContext): Promise<Array<{ id: string; name: string }>> {
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
