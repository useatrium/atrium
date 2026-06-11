import { expect, test } from '@playwright/test';
import {
  apiAs,
  channelButton,
  channelId,
  createChannel,
  login,
  mainComposer,
  messageId,
  messageRow,
  openChannel,
  postMessage,
  sendMessage,
  unique,
} from './helpers.js';

test('login lands in #general; sent message appears', async ({ page }) => {
  await login(page, unique('alice'), 'Alice');

  const text = unique('hello-general');
  await sendMessage(page, text);
});

test('realtime: bob sees alice message appear without reload', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobPage = await bob.newPage();
  await login(alicePage, unique('alice'), 'Alice');
  await login(bobPage, unique('bob'), 'Bob');

  const text = unique('realtime');
  await sendMessage(alicePage, text);
  await expect(bobPage.getByText(text, { exact: true })).toBeVisible();

  await alice.close();
  await bob.close();
});

test('thread: reply in thread; root shows reply count', async ({ page }) => {
  await login(page, unique('threader'), 'Threader');
  const root = unique('thread-root');
  const reply = unique('thread-reply');
  await sendMessage(page, root);

  const row = messageRow(page, root);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Reply in thread').click({ force: true });
  await expect(page.getByPlaceholder('Reply…')).toBeVisible();
  await page.getByPlaceholder('Reply…').fill(reply);
  await page.getByPlaceholder('Reply…').press('Enter');

  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await page.getByLabel('Close thread').click();
  await expect(page.getByRole('button', { name: '1 reply →' })).toBeVisible();
});

test('reactions: toggle a reaction, chip count updates', async ({ page }) => {
  await login(page, unique('reactor'), 'Reactor');
  const text = unique('reactable');
  await sendMessage(page, text);

  const id = await messageId(page, text);
  const add = await page.context().request.post(`/api/messages/${id}/reactions`, {
    data: { emoji: '👍' },
  });
  expect(add.ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: '👍 1, including you' })).toBeVisible();

  await page.getByRole('button', { name: '👍 1, including you' }).click();
  await expect(page.getByRole('button', { name: /👍 1/ })).toHaveCount(0);
});

test('edit and delete own message', async ({ page }) => {
  await login(page, unique('editor'), 'Editor');
  const original = unique('edit-me');
  const edited = unique('edited');
  await sendMessage(page, original);

  const row = messageRow(page, original);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Edit message').click({ force: true });
  await page.getByLabel('Edit message text').fill(edited);
  await page.getByLabel('Edit message text').press('Enter');
  await expect(page.getByText(edited, { exact: true })).toBeVisible();
  await expect(page.getByText('(edited)')).toBeVisible();

  const editedRow = messageRow(page, edited);
  const id = await messageId(page, edited);
  await expect(editedRow.getByLabel('Delete message')).toBeAttached();
  const del = await page.context().request.delete(`/api/messages/${id}`);
  expect(del.ok()).toBeTruthy();
  await expect(page.getByText(edited, { exact: true })).toHaveCount(0);
});

test('unread badge: alice posts in a second channel; bob opens it and badge clears', async ({
  browser,
}) => {
  const setup = await apiAs(unique('setup'), 'Setup');
  const second = unique('room').replace(/_/g, '-');
  await createChannel(setup, second);
  await setup.dispose();

  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobPage = await bob.newPage();
  await login(alicePage, unique('alice'), 'Alice');
  await login(bobPage, unique('bob'), 'Bob');

  await openChannel(alicePage, second);
  await sendMessage(alicePage, unique('unread'), second);

  await expect(channelButton(bobPage, second)).toContainText('unread');
  await openChannel(bobPage, second);
  await expect(channelButton(bobPage, second)).not.toContainText('unread');

  await alice.close();
  await bob.close();
});

test('cross-device read sync: reading in one context clears badge in the other', async ({
  browser,
}) => {
  const setup = await apiAs(unique('setup'), 'Setup');
  const second = unique('sync-room').replace(/_/g, '-');
  await createChannel(setup, second);
  await setup.dispose();

  const alice = await browser.newContext();
  const bobOne = await browser.newContext();
  const bobTwo = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobOnePage = await bobOne.newPage();
  const bobTwoPage = await bobTwo.newPage();
  const bobHandle = unique('bob');

  await login(alicePage, unique('alice'), 'Alice');
  await login(bobOnePage, bobHandle, 'Bob');
  await login(bobTwoPage, bobHandle, 'Bob');

  await openChannel(alicePage, second);
  await sendMessage(alicePage, unique('sync-unread'), second);
  await expect(channelButton(bobOnePage, second)).toContainText('unread');
  await expect(channelButton(bobTwoPage, second)).toContainText('unread');

  await openChannel(bobOnePage, second);
  await expect(channelButton(bobOnePage, second)).not.toContainText('unread');
  await expect(channelButton(bobTwoPage, second)).not.toContainText('unread', { timeout: 10_000 });

  await alice.close();
  await bobOne.close();
  await bobTwo.close();
});

test('search (⌘K): find an old message and jump to it', async ({ page }) => {
  const handle = unique('searcher');
  const api = await apiAs(handle, 'Searcher');
  const general = await channelId(api, 'general');
  const old = unique('ancient-search-token');
  await postMessage(api, general, old);
  for (let i = 0; i < 55; i += 1) {
    await postMessage(api, general, `${unique('newer-search-filler')} ${i}`);
  }
  await api.dispose();

  await login(page, handle, 'Searcher');
  await expect(page.getByText(old, { exact: true })).toHaveCount(0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.getByLabel('Channel and message search').fill(old);
  await expect(page.getByRole('listbox', { name: 'Message results' }).getByText(old)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByText(old, { exact: true })).toBeVisible();
});
