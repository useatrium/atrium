-- Ephemeral server-side state for provider "Connect" OAuth handshakes:
--   - Codex device authorization grant: the device_auth_id we poll against
--     auth.openai.com until the user approves on OpenAI's device page.
--   - Claude authorization-code + PKCE: the code_verifier held until the user
--     pastes back the authorization code shown by Anthropic's hosted callback.
-- Rows are short-lived (expires_at) and deleted on completion or expiry. The
-- partial unique index keeps at most one in-flight handshake per (user,
-- provider, kind) so re-clicking "Connect" replaces rather than duplicates.
-- state_ciphertext is AES-GCM sealed with the same key as provider credentials.
CREATE TABLE IF NOT EXISTS oauth_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  kind text NOT NULL,                     -- 'device' | 'pkce'
  state_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- 'pending' | 'authorized' | 'error'
  last_error text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_pending_one_inflight
  ON oauth_pending (user_id, provider, kind)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS oauth_pending_expiry ON oauth_pending (expires_at);
