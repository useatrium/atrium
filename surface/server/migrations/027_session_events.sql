CREATE TABLE session_events (
  session_id        uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  centaur_event_id  bigint      NOT NULL,
  event_kind        text        NOT NULL,
  frame             jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, centaur_event_id)
);
