import { expect, test } from '@playwright/test';
import { login, unique } from './helpers.js';

test('Claude Code spawn offers subscription auth without blocking default auth', async ({ page }) => {
  await login(page, unique('claude-user'), 'Claude User');

  await page.getByRole('button', { name: 'Start an agent session' }).click();
  await page.getByPlaceholder('What should the agent do?').fill('check claude provider wiring');
  await page.getByRole('combobox').selectOption('claude-code');

  await expect(page.getByText('Claude Code subscription auth is not connected.')).toBeVisible();
  await expect(
    page.getByText('This session will use the default harness auth. Connect Claude to prefer subscription auth.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();

  await page.getByRole('button', { name: 'Connect Claude' }).click();
  await expect(page.getByRole('dialog', { name: 'Connect Claude Code' })).toBeVisible();
  await page.getByPlaceholder('Paste Claude token').fill(`e2e-token-${Date.now()}`);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Connect Claude Code' })).toBeHidden();

  await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(
    page.getByRole('log', { name: 'Messages' }).getByText('check claude provider wiring'),
  ).toBeVisible();
});
