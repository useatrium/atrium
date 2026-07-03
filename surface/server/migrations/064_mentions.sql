CREATE TABLE mentions (
  event_id bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX mentions_user_event_idx
  ON mentions (user_id, event_id DESC);
