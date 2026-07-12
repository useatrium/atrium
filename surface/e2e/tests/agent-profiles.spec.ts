import { expect, request, test } from '@playwright/test';
import pg from 'pg';
import { apiURL, login, unique } from './helpers.js';

const databaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';
const SHA = 'b'.repeat(64);

test('profile proposal review applies session lineage', async ({ page }) => {
  const handle = unique('profile-user');
  await login(page, handle, 'Profile User');

  const pool = new pg.Pool({ connectionString: databaseUrl });
  let sessionId = '';
  try {
    const ids = await pool.query<{ user_id: string; channel_id: string; workspace_id: string }>(
      `SELECT u.id AS user_id, c.id AS channel_id, c.workspace_id
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       JOIN channels c ON c.workspace_id = wm.workspace_id AND c.name = 'general'
       WHERE u.handle = $1
       LIMIT 1`,
      [handle],
    );
    const row = ids.rows[0];
    if (!row) throw new Error('missing e2e user/channel');
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by, harness)
       VALUES ($1, $2, $3, 'profile review e2e', 'running', $4, 'codex')
       RETURNING id`,
      [row.workspace_id, row.channel_id, `e2e-profile-${Date.now()}`, row.user_id],
    );
    sessionId = inserted.rows[0]!.id;
  } finally {
    await pool.end();
  }

  const internal = await request.newContext({
    baseURL: apiURL,
    extraHTTPHeaders: { 'x-api-key': 'e2e-capture-key' },
  });
  try {
    const seeded = await internal.put(`/api/internal/sessions/${sessionId}/profile-candidates?harness=codex`, {
      data: {
        provider: 'codex',
        adapterVersion: 'e2e',
        sourceHashes: [{ path: '.codex/config.toml', sha256: SHA }],
        manifest: {
          settings: {
            model: 'gpt-5',
            api_key: 'sk-this-secret-is-blocked-1234567890',
          },
        },
      },
    });
    expect(seeded.ok()).toBeTruthy();
  } finally {
    await internal.dispose();
  }

  await page.goto(`/s/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'profile review e2e' })).toBeVisible();
  await expect(page.getByTestId('profile-changes-banner')).toBeVisible();
  await expect(page.getByText(/secret-shaped values blocked/)).toBeVisible();
  await page.getByRole('button', { name: 'Apply lineage' }).click();
  await expect(page.getByTestId('profile-changes-banner')).toBeHidden();
});
