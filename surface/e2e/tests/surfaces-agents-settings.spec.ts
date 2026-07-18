import { expect, test } from '@playwright/test';
import { login, unique } from './helpers.js';

// The Agents surface (/agents) was retired: agents now live only in the
// right-hand Agent Dock, so there is no addressable Agents page to test here.
// Dock behavior is covered by the AgentDock unit tests; this file keeps the
// Settings-surface addressability coverage.

test('Settings is addressable, reload-restores, and Back returns to chat', async ({ page }) => {
  await login(page, unique('settings-surface'), 'Settings Surface');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: /^Settings$/ }).first()).toBeVisible();
  await expect(page.getByText('Theme')).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: /^Settings$/ }).first()).toBeVisible();
  await expect(page.getByText('Theme')).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
});
