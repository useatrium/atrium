import { expect, test } from '@playwright/test';
import { login, unique } from './helpers.js';

test('Claude Code spawn offers subscription auth without blocking default auth', async ({ page }) => {
  await login(page, unique('claude-user'), 'Claude User');

  await page.getByRole('button', { name: 'New agent' }).click();
  await page.getByPlaceholder('What should the agent do?').fill('check claude provider wiring');
  await page.getByRole('combobox').selectOption('claude-code');

  // Calm, neutral note (no longer a "not connected" warning): the default auth
  // works and Connect is an opt-in upgrade. (Apostrophe is a typographic ’.)
  await expect(page.getByText(/Using Atrium.s default agent auth\./)).toBeVisible();
  await expect(page.getByText(/run on your own subscription/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();

  await page.getByRole('button', { name: 'Connect Claude' }).click();
  const claudeDialog = page.getByRole('dialog', { name: 'Connect Claude Code' });
  await expect(claudeDialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Claude sign-in' })).toBeVisible();
  await expect(page.getByPlaceholder('Paste Claude code')).toBeVisible();
  await claudeDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(claudeDialog).toBeHidden();

  await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(
    page.getByRole('log', { name: 'Messages' }).getByText('check claude provider wiring'),
  ).toBeVisible();
});
