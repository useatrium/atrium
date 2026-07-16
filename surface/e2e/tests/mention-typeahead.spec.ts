import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

const apiURL = `http://127.0.0.1:${Number(process.env.E2E_SERVER_PORT ?? 3101)}`;

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueChannel(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).slice(-6)}-${Math.random().toString(36).slice(2, 7)}`.slice(0, 32);
}

async function login(page: Page, handle: string, displayName: string): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder('gary', { exact: true }).fill(handle);
  await page.getByPlaceholder('Gary Basin').fill(displayName);
  await page.getByRole('button', { name: 'Continue with a handle' }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible();
}

async function apiAs(handle: string, displayName: string): Promise<APIRequestContext> {
  const context = await request.newContext({ baseURL: apiURL });
  const response = await context.post('/auth/login', { data: { handle, displayName } });
  expect(response.ok()).toBeTruthy();
  return context;
}

async function createChannel(context: APIRequestContext, name: string): Promise<void> {
  const response = await context.post('/api/channels', { data: { name } });
  expect(response.ok()).toBeTruthy();
}

test('channel composer inserts and renders a stable user mention', async ({ page }) => {
  const suffix = Math.random().toString(36).slice(2, 7);
  const handleB = `mentionb-${suffix}`;
  const displayB = `Mention Target ${suffix}`;
  const userB = await apiAs(handleB, displayB);
  const channelName = uniqueChannel('mentions');
  await createChannel(userB, channelName);

  try {
    await login(page, unique('mention-a'), 'Mention Author');
    await page.getByRole('button', { name: new RegExp(`^#?\\s*${channelName}(\\s|$|unread)`) }).click();
    await expect(page.getByRole('heading', { name: `# ${channelName}` })).toBeVisible();

    const composer = page.locator('main').getByRole('combobox', { name: 'Message input' });
    // Type a unique prefix — the shared e2e workspace accumulates users across
    // specs, and a bare "@" caps the list at 8 alphabetical rows.
    await composer.fill(`@${handleB.slice(0, -1)}`);
    const listbox = page.getByRole('listbox', { name: 'Mention suggestions' });
    await expect(listbox).toBeVisible();
    const target = listbox.getByRole('option').filter({ hasText: `@${handleB}` });
    await expect(target).toBeVisible();

    // Exercise keyboard navigation even when the target happens to be the
    // initially selected, in-channel candidate.
    await composer.press('ArrowDown');
    for (let step = 0; step < 12 && (await target.getAttribute('aria-selected')) !== 'true'; step += 1) {
      await composer.press('ArrowDown');
    }
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await composer.press('Enter');
    await expect(composer).toHaveValue(`@${handleB} `);

    await composer.press('Enter');
    await expect(page.getByText(`@${displayB}`, { exact: true })).toBeVisible();
  } finally {
    await userB.dispose();
  }
});
