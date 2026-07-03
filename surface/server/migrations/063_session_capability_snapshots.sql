CREATE TABLE IF NOT EXISTS session_capability_snapshots (
  session_id uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  harness    text        NOT NULL CHECK (harness IN ('claude', 'codex')),
  source_sha256 text     NOT NULL,
  parser_version integer NOT NULL,
  snapshot_json jsonb    NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, harness)
);

CREATE INDEX IF NOT EXISTS session_capability_snapshots_updated
  ON session_capability_snapshots (updated_at DESC);
