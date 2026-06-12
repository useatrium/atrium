-- Multi-workspace tenancy: user→workspace membership mapping.
-- Visibility of "public" channels becomes scoped to workspace members;
-- private/dm/gdm channels keep channel_members as their boundary.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Membership lookups are user-first (workspaceIdsFor, sync visibility).
CREATE INDEX IF NOT EXISTS workspace_members_user
  ON workspace_members (user_id, workspace_id);

-- Backfill: every existing user joins every existing workspace, preserving
-- the pre-tenancy visibility (single-tenant deployments see no change).
INSERT INTO workspace_members (workspace_id, user_id)
SELECT w.id, u.id FROM workspaces w CROSS JOIN users u
ON CONFLICT DO NOTHING;
