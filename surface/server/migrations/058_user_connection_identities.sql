CREATE TABLE IF NOT EXISTS user_connection_identities (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  identity_id text NOT NULL,
  status text NOT NULL DEFAULT 'connected',
  token_kind text NOT NULL,
  account_login text,
  account_label text,
  scopes text[] NOT NULL DEFAULT '{}',
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT false,
  last_validated_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, provider, identity_id)
);

CREATE INDEX IF NOT EXISTS user_connection_identities_user_workspace_idx
  ON user_connection_identities (user_id, workspace_id, provider);

CREATE UNIQUE INDEX IF NOT EXISTS user_connection_identities_one_active_idx
  ON user_connection_identities (workspace_id, user_id, provider)
  WHERE active;

INSERT INTO user_connection_identities
  (workspace_id, user_id, provider, identity_id, status, token_kind, account_login, account_label,
   scopes, capabilities, metadata, active, last_validated_at, last_error, created_at, updated_at)
SELECT workspace_id,
       user_id,
       provider,
       CASE
         WHEN token_kind = 'app_installation' AND jsonb_extract_path_text(metadata, 'installationId') IS NOT NULL
           THEN 'github:app_installation:' || jsonb_extract_path_text(metadata, 'installationId')
         WHEN token_kind = 'app_installation'
           THEN 'github:app_installation'
         WHEN token_kind = 'app_user'
           THEN 'github:app_user'
         WHEN token_kind = 'pat'
           THEN 'github:pat'
         ELSE provider || ':' || COALESCE(token_kind, 'public_read')
       END,
       status,
       COALESCE(token_kind, 'public_read'),
       account_login,
       account_label,
       scopes,
       capabilities,
       metadata,
       status = 'connected',
       last_validated_at,
       last_error,
       created_at,
       updated_at
  FROM user_connections
 WHERE provider = 'github'
   AND token_kind IS NOT NULL
ON CONFLICT (workspace_id, user_id, provider, identity_id) DO NOTHING;
