CREATE TABLE IF NOT EXISTS user_connections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'public_read',
  token_kind text,
  account_login text,
  account_label text,
  scopes text[] NOT NULL DEFAULT '{}',
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_validated_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, provider)
);

CREATE INDEX IF NOT EXISTS user_connections_user_workspace_idx
  ON user_connections (user_id, workspace_id);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS provider_connection_id text,
  ADD COLUMN IF NOT EXISTS github_identity_mode text;
