import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { apiAs, channelId, login, postMessage, postWithAttachment, unique, uploadViaApi } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 1000 },
] as const;

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
}

async function expectNoDocumentOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${label}: document width ${dimensions.scrollWidth}px exceeds ${dimensions.clientWidth}px viewport`,
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function expectVisibleFocus(locator: Locator): Promise<void> {
  // Enter keyboard modality before returning focus to the target. A bare
  // programmatic focus does not necessarily match :focus-visible in Chromium.
  await locator.focus();
  await locator.press('Tab');
  await locator.focus();
  await expect(locator).toBeFocused();
  const indicator = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      boxShadow: style.boxShadow,
    };
  });
  expect(
    (indicator.outlineStyle !== 'none' && indicator.outlineWidth >= 1) || indicator.boxShadow !== 'none',
    `focused control has no computed outline or box-shadow: ${JSON.stringify(indicator)}`,
  ).toBe(true);
}

function rgb(value: string): [number, number, number] {
  const channels = value
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (!channels || channels.length !== 3) throw new Error(`unsupported computed color: ${value}`);
  return channels as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(rgb(foreground)), luminance(rgb(background)));
  const darker = Math.min(luminance(rgb(foreground)), luminance(rgb(background)));
  return (lighter + 0.05) / (darker + 0.05);
}

async function expectComputedContrast(locator: Locator, minimum: number): Promise<void> {
  const colors = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    let background = style.backgroundColor;
    let ancestor = element.parentElement;
    while (background === 'rgba(0, 0, 0, 0)' && ancestor) {
      background = getComputedStyle(ancestor).backgroundColor;
      ancestor = ancestor.parentElement;
    }
    return { foreground: style.color, background };
  });
  expect(
    contrastRatio(colors.foreground, colors.background),
    `contrast for ${JSON.stringify(colors)} should be at least ${minimum}:1`,
  ).toBeGreaterThanOrEqual(minimum);
}

async function seedCompletedSession(handle: string, title: string): Promise<string> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [handle]);
    const channel = await client.query<{ id: string; workspace_id: string }>(
      "SELECT id, workspace_id FROM channels WHERE name = 'general'",
    );
    if (!user.rows[0] || !channel.rows[0]) throw new Error('missing e2e user or #general');
    const session = await client.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation, result_text, completed_at
       ) VALUES ($1, $2, $3, 'codex', $4, 'completed', $5, $5, $6, 1, $7, now())
       RETURNING id`,
      [
        channel.rows[0].workspace_id,
        channel.rows[0].id,
        `thread-${unique('audit')}`,
        title,
        user.rows[0].id,
        unique('execution'),
        'Audit fixture completed successfully. Review the produced file and terminal outcome.',
      ],
    );
    const sessionId = session.rows[0]!.id;
    const event = await client.query<{ id: string }>(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       VALUES ($1, $2, 'session.spawned', $3, $4) RETURNING id`,
      [
        channel.rows[0].workspace_id,
        channel.rows[0].id,
        user.rows[0].id,
        JSON.stringify({ sessionId, title, harness: 'codex', by: user.rows[0].id }),
      ],
    );
    await client.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [
      Number(event.rows[0]!.id),
      sessionId,
    ]);
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

for (const viewport of VIEWPORTS) {
  test(`authenticated shell remains operable at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByPlaceholder('gary', { exact: true })).toBeVisible();
    await expectNoDocumentOverflow(page, `${viewport.name} login`);

    await login(page, unique('audit'), `Audit ${viewport.name}`);
    await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
    await expect(page.getByRole('button', { name: /search/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keyboard shortcuts' })).toBeVisible();
    if (viewport.width < 768) {
      await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
      await page.getByRole('button', { name: 'Open navigation' }).click();
    }
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Attention$/ })).toBeVisible();
    await expectNoDocumentOverflow(page, `${viewport.name} authenticated shell`);
    if (viewport.name === 'phone') await attachScreenshot(page, testInfo, 'empty-phone-shell');
  });
}

test('empty destinations, keyboard focus, and deterministic contrast have evidence', async ({ page }, testInfo) => {
  await page.setViewportSize(VIEWPORTS[3]);
  await login(page, unique('audit-empty'), 'Audit Empty');

  const attention = page.getByRole('button', { name: /Attention$/ });
  await expectVisibleFocus(attention);
  await attention.press('Enter');
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await expectComputedContrast(page.getByText("You're all caught up"), 4.5);
  await attachScreenshot(page, testInfo, 'empty-attention');

  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByPlaceholder('Search agents')).toBeVisible();
  await attachScreenshot(page, testInfo, 'empty-agents');

  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Files/ }).first()).toBeVisible();
  await attachScreenshot(page, testInfo, 'empty-files');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const light = page.getByRole('button', { name: 'Light', exact: true });
  await expectVisibleFocus(light);
  await attachScreenshot(page, testInfo, 'settings-default');
});

test('light, dark, high contrast, 125% text, and reduced motion preferences render', async ({ page }, testInfo) => {
  await login(page, unique('audit-prefs'), 'Audit Preferences');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
    await expectComputedContrast(page.getByRole('heading', { name: 'Settings' }).first(), 4.5);
    await attachScreenshot(page, testInfo, `settings-${theme.toLowerCase()}`);
  }

  await page.getByRole('button', { name: 'High contrast' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
  await page.getByRole('button', { name: 'XL text size' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-fontscale', '1.25');
  await page.getByRole('button', { name: 'Reduced', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await expectNoDocumentOverflow(page, 'settings accessibility preferences');
  await attachScreenshot(page, testInfo, 'settings-high-contrast-125-reduced');
});

test('dense chat, populated Files and a completed session Results state render', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const handle = unique('audit-populated');
  const ctx = await apiAs(handle, 'Audit Populated');
  const fileName = `${unique('design-evidence')}.txt`;
  try {
    const general = await channelId(ctx, 'general');
    for (let index = 1; index <= 12; index += 1) {
      await postMessage(ctx, general, `Audit conversation ${index}: a representative populated workspace message.`);
    }
    const fileId = await uploadViaApi(
      ctx,
      fileName,
      'text/plain',
      Buffer.from('Durable design audit evidence fixture.\n', 'utf8'),
    );
    await postWithAttachment(ctx, general, 'Produced design audit evidence', fileId);
  } finally {
    await ctx.dispose();
  }

  await login(page, handle, 'Audit Populated');
  await expect(page.getByText('Audit conversation 12: a representative populated workspace message.')).toBeVisible();
  await expectNoDocumentOverflow(page, 'dense chat');
  await attachScreenshot(page, testInfo, 'dense-chat');

  const sessionTitle = unique('completed-audit-session');
  const sessionId = await seedCompletedSession(handle, sessionTitle);
  await page.goto('/agents');
  await expect(page.getByTestId('agents-surface').getByText(sessionTitle, { exact: true })).toBeVisible();
  await attachScreenshot(page, testInfo, 'populated-agents');

  await page.goto(`/s/${sessionId}`);
  await expect(page.getByRole('heading', { name: sessionTitle })).toBeVisible();
  await expect(page.getByTestId('session-result')).toContainText('Results');
  await expect(page.getByTestId('session-result')).toContainText('Completed');
  await expectNoDocumentOverflow(page, 'terminal Results');
  await attachScreenshot(page, testInfo, 'terminal-results');

  await page.goto('/files');
  await expect(page.getByText(fileName, { exact: true }).first()).toBeVisible();
  await expectNoDocumentOverflow(page, 'populated Files');
  await attachScreenshot(page, testInfo, 'populated-files');
});
