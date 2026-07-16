import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { channelId, createTestChannel, injectSession, login, openChannel, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

/**
 * Finish a session the way real life does when the tab was closed: the sessions
 * row goes terminal, but no session.completed event lands in the timeline page
 * the client will fetch. That is precisely the shape that used to fabricate a
 * phantom: history replay saw only session.spawned.
 */
async function completeWithoutTimelineEvent(sessionId: string): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE sessions
          SET status = 'completed',
              completed_at = now() - interval '2 hours',
              result_text = 'done'
        WHERE id = $1`,
      [sessionId],
    );
  } finally {
    client.release();
    await pool.end();
  }
}

test('a finished session does not come back as running on reload, and the box stays put', async ({ page }) => {
  const room = await createTestChannel('reload-agent-work');
  const handle = unique('reload-aw');
  await login(page, handle, 'Reload Agent Work');
  const roomId = await channelId(page.context().request, room);
  await openChannel(page, room);

  const title = unique('ancient-task');
  const { sessionId } = await injectSession({ handle, channelId: roomId, title });
  await completeWithoutTimelineEvent(sessionId);

  await page.reload();

  const agentWork = page.getByRole('navigation').getByRole('button', { name: /^Agent work/ });

  // The box must never vanish. Before sessions were snapshot-backed, the folded
  // spawn rendered as running, a per-session heal GET corrected it to terminal,
  // the last row filtered out, and the whole section unmounted.
  await expect(agentWork).toBeVisible();

  // And the finished session must never present as live work. With no heal loop
  // left to paper over it, a fold that fabricates a status again would strand
  // this row as running forever instead of self-correcting — so this stays red.
  const phantom = page.getByRole('button', { name: new RegExp(`${title} — running`) });
  await expect(phantom).toHaveCount(0);

  // Recent is present as the resting state — its *contents* are asserted in
  // Sidebar.agent-work.test.tsx instead: this workspace is shared by the whole
  // suite, so which sessions land inside Recent's cap here depends on whatever
  // every other spec happened to complete.
  await expect(page.getByRole('navigation').getByRole('button', { name: /^Recent/ })).toBeVisible();

  // Still true once the network has fully settled — this is where the old heal
  // loop landed and emptied the box.
  await page.waitForLoadState('networkidle');
  await expect(agentWork).toBeVisible();
  await expect(phantom).toHaveCount(0);
});
