import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { channelId, createTestChannel, injectSession, login, openChannel, seedEvent, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

async function makeSessionNeedAnAnswer(sessionId: string): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await client.query<{
      workspace_id: string;
      channel_id: string;
      spawned_by: string;
      thread_root_event_id: number;
    }>('SELECT workspace_id, channel_id, spawned_by, thread_root_event_id FROM sessions WHERE id = $1', [sessionId]);
    const row = session.rows[0];
    if (!row) throw new Error('missing seeded session');
    const pending = {
      questionId: 'sidebar-question',
      questions: [{ id: 'sidebar-prompt', header: 'Confirm', question: 'Which deployment should I use?' }],
      askedAt: new Date().toISOString(),
    };
    await client.query('UPDATE sessions SET pending_question = $1 WHERE id = $2', [JSON.stringify(pending), sessionId]);
    await seedEvent(client, {
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      threadRootEventId: row.thread_root_event_id,
      type: 'session.question_requested',
      actorId: row.spawned_by,
      payload: { sessionId, questionId: pending.questionId, questions: pending.questions },
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

test('Agent work shows live sessions, persists collapse, and opens a selected session', async ({ page }) => {
  const room = await createTestChannel('sidebar-agent-work');
  // Handles cap at 32 chars — keep the prefix short enough for unique()'s suffix.
  const handle = unique('sidebar-aw');
  await login(page, handle, 'Sidebar Agent Work');
  const roomId = await channelId(page.context().request, room);
  await openChannel(page, room);

  const needsYouTitle = unique('needs-answer');
  const runningTitle = unique('running-session');
  const { sessionId: needsYouId } = await injectSession({ handle, channelId: roomId, title: needsYouTitle });
  const { sessionId: runningId } = await injectSession({ handle, channelId: roomId, title: runningTitle });
  await makeSessionNeedAnAnswer(needsYouId);
  await page.reload();

  const agentWork = page.getByRole('navigation').getByRole('button', { name: /^Agent work/ });
  await expect(agentWork).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: `${needsYouTitle} — needs your answer` })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(`${runningTitle} — running,`) })).toBeVisible();

  await agentWork.click();
  await expect(agentWork).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(page.getByRole('navigation').getByRole('button', { name: /^Agent work/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Agent work/ })
    .click();
  await page.getByRole('button', { name: new RegExp(`${runningTitle} — running,`) }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${runningId}`));
});
