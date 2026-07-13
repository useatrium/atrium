-- Per-item "mark unread" exceptions on top of the activity watermark.
-- Unread = event_id > last_read_event_id OR (user_id, event_id) in this table.
CREATE TABLE activity_unread_exceptions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);

CREATE INDEX activity_unread_exceptions_user_idx
  ON activity_unread_exceptions (user_id);
