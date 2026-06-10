CREATE TABLE IF NOT EXISTS session_views (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE INDEX IF NOT EXISTS session_views_session_user
  ON session_views (session_id, user_id);
