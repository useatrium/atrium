CREATE TABLE IF NOT EXISTS session_projection_state (
  session_id     uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  last_event_id  bigint NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
