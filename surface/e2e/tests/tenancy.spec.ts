import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { channelButton, login, openChannel, unique } from './helpers.js';

const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

interface WorkspaceSeed {
  workspaceId: string;
  channelId: string;
  messageText: string;
}

async function seedWorkspaceB(args: {
  memberHandle: string;
  workspaceName: string;
  messageText: string;
}): Promise<WorkspaceSeed> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [
      args.memberHandle,
    ]);
    const actorId = user.rows[0]?.id;
    if (!actorId) throw new Error(`missing e2e user: ${args.memberHandle}`);

    const workspace = await client.query<{ id: string }>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id',
      [args.workspaceName],
    );
    const workspaceId = workspace.rows[0]!.id;
    const channel = await client.query<{ id: string }>(
      `INSERT INTO channels (workspace_id, name, kind, created_by)
       VALUES ($1, 'b-general', 'public', $2)
       RETURNING id`,
      [workspaceId, actorId],
    );
    const channelId = channel.rows[0]!.id;
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [workspaceId, actorId],
    );
    await client.query(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       VALUES ($1, $2, 'message.posted', $3, $4)`,
      [workspaceId, channelId, actorId, JSON.stringify({ text: args.messageText })],
    );
    await client.query('COMMIT');
    return { workspaceId, channelId, messageText: args.messageText };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

test('public workspace channels are visible only to workspace members', async ({ browser }) => {
  const nonMember = await browser.newContext();
  const member = await browser.newContext();
  const nonMemberPage = await nonMember.newPage();
  const memberPage = await member.newPage();
  const nonMemberHandle = unique('tenant-nonmember');
  const memberHandle = unique('tenant-member');
  const seededText = unique('wsb-message');

  try {
    await login(nonMemberPage, nonMemberHandle, 'Tenant Nonmember');
    await login(memberPage, memberHandle, 'Tenant Member');

    const seeded = await seedWorkspaceB({
      memberHandle,
      workspaceName: unique('wsB'),
      messageText: seededText,
    });

    await Promise.all([nonMemberPage.reload(), memberPage.reload()]);
    await expect(memberPage.getByRole('heading', { name: '# general' })).toBeVisible();
    await expect(nonMemberPage.getByRole('heading', { name: '# general' })).toBeVisible();

    await expect.soft(channelButton(nonMemberPage, 'b-general')).toHaveCount(0); // red-until-merge: V

    const sync = await nonMemberPage.context().request.get('/api/sync?after=0&limit=1000');
    expect(sync.ok()).toBeTruthy();
    const syncBody = (await sync.json()) as { events: Array<{ workspaceId: string }> };
    expect
      .soft(syncBody.events.filter((event) => event.workspaceId === seeded.workspaceId))
      .toHaveLength(0); // red-until-merge: V

    await expect(channelButton(memberPage, 'b-general')).toBeVisible();
    await openChannel(memberPage, 'b-general');
    await expect(memberPage.getByText(seeded.messageText, { exact: true })).toBeVisible();

    const historyProbe = await nonMemberPage
      .context()
      .request.get(`/api/channels/${seeded.channelId}/messages?limit=20`);
    expect.soft([403, 404]).toContain(historyProbe.status()); // red-until-merge: V

    const workspaces = await nonMemberPage.context().request.get('/api/workspaces');
    expect(workspaces.ok()).toBeTruthy();
    const workspacesBody = (await workspaces.json()) as {
      workspaces: Array<{ id: string }>;
    };
    expect
      .soft(workspacesBody.workspaces.some((workspace) => workspace.id === seeded.workspaceId))
      .toBe(false); // red-until-merge: R
  } finally {
    await nonMember.close();
    await member.close();
  }
});
