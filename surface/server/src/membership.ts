import type { Db, DbClient } from './db.js';

/**
 * Workspace membership helpers — the tenancy boundary.
 *
 * "Public" channel visibility is scoped to members of the channel's
 * workspace; private/dm/gdm channels keep channel_members as their boundary.
 * SQL that filters events or channels by workspace should use
 * WORKSPACE_MEMBER_EXISTS with the appropriate column/param names.
 */

/** EXISTS fragment: is `userParam` a member of the workspace in `workspaceIdExpr`? */
export function workspaceMemberExists(workspaceIdExpr: string, userParam: string): string {
  return `EXISTS (SELECT 1 FROM workspace_members wm
                  WHERE wm.workspace_id = ${workspaceIdExpr} AND wm.user_id = ${userParam})`;
}

/** Workspaces the user belongs to, oldest membership first. */
export async function workspaceIdsFor(db: Db | DbClient, userId: string): Promise<string[]> {
  const res = await db.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_members
     WHERE user_id = $1 ORDER BY created_at ASC, workspace_id ASC`,
    [userId],
  );
  return res.rows.map((r) => r.workspace_id);
}

export async function isWorkspaceMember(db: Db | DbClient, userId: string, workspaceId: string): Promise<boolean> {
  const res = await db.query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
    workspaceId,
    userId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/** Idempotent; safe to call on signup and on explicit invite. */
export async function addWorkspaceMember(db: Db | DbClient, workspaceId: string, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [workspaceId, userId],
  );
}

/** All member user ids of a workspace (for scoped WS fanout). */
export async function workspaceMemberIds(db: Db | DbClient, workspaceId: string): Promise<string[]> {
  const res = await db.query<{ user_id: string }>('SELECT user_id FROM workspace_members WHERE workspace_id = $1', [
    workspaceId,
  ]);
  return res.rows.map((r) => r.user_id);
}
