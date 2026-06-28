CREATE TABLE IF NOT EXISTS session_debug_captures (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  execution_id text,
  entry_uid    text,
  capture_mode text        NOT NULL,
  event_kind   text        NOT NULL,
  payload      jsonb       NOT NULL,
  actor_id     uuid        REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_debug_captures_capture_mode_check
    CHECK (capture_mode IN ('standard', 'admin_verbose'))
);

CREATE INDEX IF NOT EXISTS session_debug_captures_session_created
  ON session_debug_captures (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS session_debug_captures_expiry
  ON session_debug_captures (expires_at)
  WHERE expires_at IS NOT NULL;
