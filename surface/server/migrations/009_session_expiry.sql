-- Sessions expire server-side. Active sessions slide (renewed on use when
-- under 15 days remain); idle ones die after 30 days.

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days');

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at);
