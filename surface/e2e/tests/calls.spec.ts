import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import {
  apiAs,
  createChannel,
  login,
  openChannel,
  unique,
  uniqueChannel,
} from './helpers.js';

const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

async function userIdFor(handle: string): Promise<string> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  try {
    const user = await pool.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [
      handle,
    ]);
    const id = user.rows[0]?.id;
    if (!id) throw new Error(`missing e2e user: ${handle}`);
    return id;
  } finally {
    await pool.end();
  }
}

async function seedCall(args: {
  channelId: string;
  initiatorId: string;
  participantIds: string[];
  status: 'ringing' | 'active';
}): Promise<string> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const channel = await client.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM channels WHERE id = $1',
      [args.channelId],
    );
    const workspaceId = channel.rows[0]?.workspace_id;
    if (!workspaceId) throw new Error(`missing e2e channel: ${args.channelId}`);

    const call = await client.query<{ id: string }>(
      `INSERT INTO calls (workspace_id, channel_id, initiator_id, room, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [workspaceId, args.channelId, args.initiatorId, `call:${unique('e2e')}`, args.status],
    );
    const callId = call.rows[0]!.id;
    for (const userId of args.participantIds) {
      await client.query('INSERT INTO call_participants (call_id, user_id) VALUES ($1, $2)', [
        callId,
        userId,
      ]);
    }
    await client.query('COMMIT');
    return callId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function activateCall(callId: string, participantId: string): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  try {
    await pool.query('UPDATE calls SET status = $2 WHERE id = $1', [callId, 'active']);
    await pool.query(
      `INSERT INTO call_participants (call_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (call_id, user_id) DO UPDATE SET left_at = NULL`,
      [callId, participantId],
    );
  } finally {
    await pool.end();
  }
}

test('active call recovery shows ringing and rejoin affordances after navigation and reload', async ({
  page,
}) => {
  const aliceHandle = unique('call-alice');
  const bobHandle = unique('call-bob');
  const room = uniqueChannel('calls');
  const aliceApi = await apiAs(aliceHandle, 'Alice Caller');
  const bobApi = await apiAs(bobHandle, 'Bob Listener');
  try {
    const callChannelId = await createChannel(aliceApi, room);
    const aliceId = await userIdFor(aliceHandle);
    const bobId = await userIdFor(bobHandle);
    const callId = await seedCall({
      channelId: callChannelId,
      initiatorId: aliceId,
      participantIds: [aliceId],
      status: 'ringing',
    });

    await login(page, bobHandle, 'Bob Listener');
    await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0);

    await openChannel(page, room);
    await expect(page.getByText('Alice Caller is calling')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Decline' })).toBeVisible();

    await activateCall(callId, bobId);
    await page.reload();
    // URL is the source of truth: reload restores the call channel directly
    // (previously the channel wasn't in the URL, so reload dropped back to
    // #general and the room had to be re-opened). Recovery affordances must
    // still surface for the restored channel.
    await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
    await expect(page.getByText('Live call')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rejoin' })).toBeVisible();
  } finally {
    await aliceApi.dispose();
    await bobApi.dispose();
  }
});
