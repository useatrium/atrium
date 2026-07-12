ALTER TABLE sessions ADD COLUMN archived_at timestamptz;
ALTER TABLE channels ADD COLUMN archived_at timestamptz;

CREATE TABLE channel_pins (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE session_pins (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX sessions_auto_archive_candidates
  ON sessions (COALESCE(completed_at, created_at))
  WHERE archived_at IS NULL
    AND status IN ('completed', 'failed', 'cancelled');

CREATE INDEX sessions_archived_list
  ON sessions (archived_at DESC)
  WHERE archived_at IS NOT NULL;
