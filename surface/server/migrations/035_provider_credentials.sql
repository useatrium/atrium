CREATE TABLE IF NOT EXISTS user_provider_credentials (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  token_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'connected',
  last_validated_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS provider_credential_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider_auth_required jsonb;

CREATE INDEX IF NOT EXISTS sessions_provider_auth_required_idx
  ON sessions (provider_credential_user_id)
  WHERE provider_auth_required IS NOT NULL;
