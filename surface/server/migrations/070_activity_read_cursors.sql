CREATE TABLE activity_read_cursors (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_read_event_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
