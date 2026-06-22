CREATE TABLE IF NOT EXISTS session_records (
  session_id uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id   bigint      NOT NULL,
  seq        int         NOT NULL,
  kind       text        NOT NULL,
  actor      text        NOT NULL,
  driver     text,
  view_tier  text        NOT NULL,
  text       text        NOT NULL,
  meta       jsonb       NOT NULL DEFAULT '{}',
  ts         timestamptz NOT NULL,
  tsv        tsvector    GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS session_records_tsv_idx
  ON session_records USING GIN (tsv);

CREATE INDEX IF NOT EXISTS session_records_session_kind_idx
  ON session_records (session_id, kind);
