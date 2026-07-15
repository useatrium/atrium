import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { channelId, createTestChannel, injectSession, login, openChannel, seedEvent, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

async function setNeedsAnswer(sessionId: string): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      workspace_id: string;
      channel_id: string;
      spawned_by: string;
      thread_root_event_id: number;
    }>('SELECT workspace_id, channel_id, spawned_by, thread_root_event_id FROM sessions WHERE id = $1', [sessionId]);
    const session = result.rows[0];
    if (!session) throw new Error('missing seeded session');
    const pending = {
      questionId: 'channel-strip-question',
      questions: [{ id: 'channel-strip-prompt', header: 'Confirm', question: 'Which deployment should I use?' }],
      askedAt: new Date().toISOString(),
    };
    await client.query('UPDATE sessions SET pending_question = $1 WHERE id = $2', [JSON.stringify(pending), sessionId]);
    await seedEvent(client, {
      workspaceId: session.workspace_id,
      channelId: session.channel_id,
      threadRootEventId: session.thread_root_event_id,
      type: 'session.question_requested',
      actorId: session.spawned_by,
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

async function completeSession(sessionId: string): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      workspace_id: string;
      channel_id: string;
      spawned_by: string;
      thread_root_event_id: number;
    }>('SELECT workspace_id, channel_id, spawned_by, thread_root_event_id FROM sessions WHERE id = $1', [sessionId]);
    const session = result.rows[0];
    if (!session) throw new Error('missing seeded session');
    const resultText = 'Completed the channel-strip check.';
    await client.query(
      "UPDATE sessions SET status = 'completed', completed_at = now(), result_text = $1 WHERE id = $2",
      [resultText, sessionId],
    );
    await seedEvent(client, {
      workspaceId: session.workspace_id,
      channelId: session.channel_id,
      threadRootEventId: session.thread_root_event_id,
      type: 'session.completed',
      actorId: session.spawned_by,
      payload: { sessionId, status: 'completed', resultExcerpt: resultText, permalink: `/s/${sessionId}` },
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

test('ChannelStrip summarizes channel work and opens a selected session', async ({ page }) => {
  const room = await createTestChannel('channel-strip');
  const quietRoom = await createTestChannel('channel-quiet');
  // Handles cap at 32 chars — keep the prefix short enough for unique()'s suffix.
  const handle = unique('strip');
  await login(page, handle, 'Channel Strip');
  const roomId = await channelId(page.context().request, room);
  await openChannel(page, room);

  const needsTitle = unique('needs');
  const runningTitle = unique('running');
  const completedTitle = unique('complete');
  const { sessionId: needsId } = await injectSession({ handle, channelId: roomId, title: needsTitle });
  await injectSession({ handle, channelId: roomId, title: runningTitle });
  const { sessionId: completedId } = await injectSession({ handle, channelId: roomId, title: completedTitle });
  await setNeedsAnswer(needsId);
  await completeSession(completedId);
  await page.reload();

  const toggle = page.getByRole('button', { name: 'Agent work in this channel: 1 needs you, 1 running, 1 to review' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(page.getByTestId('channel-strip-panel')).toBeVisible();
  await expect(page.getByTestId(`channel-strip-row-${needsId}`)).toContainText(needsTitle);
  await expect(page.getByTestId(`channel-strip-row-${completedId}`)).toContainText(completedTitle);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('channel-strip-panel')).toBeHidden();
  await toggle.click();

  await page.getByTestId(`channel-strip-row-${needsId}`).click();
  await expect(page).toHaveURL(new RegExp(`/c/${roomId}/s/${needsId}`));

  await openChannel(page, quietRoom);
  await expect(page.getByTestId('channel-strip')).toHaveCount(0);
});
