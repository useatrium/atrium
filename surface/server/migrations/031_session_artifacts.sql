-- Captured artifacts: durable offload state. Each row mirrors an
-- `artifact.captured` frame (populated from the session_events mirror path).
-- Bytes start in Centaur's ephemeral staging keyed by (execution_id,
-- centaur_ref); a background worker offloads them to atrium's S3 (s3_key) so
-- they survive Centaur retention. `centaur_ref IS NULL` = manifest-only (the
-- file was too large / filtered as junk), so it never offloads.

CREATE TABLE IF NOT EXISTS session_artifacts (
  -- artifact_id: a content hash, immutable per (session, content).
  id           text        NOT NULL,
  session_id   uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  execution_id text,
  centaur_ref  text,
  s3_key       text,
  path         text        NOT NULL,
  mime         text        NOT NULL,
  size_bytes   bigint      NOT NULL,
  sha256       text        NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  offloaded_at timestamptz,
  PRIMARY KEY (session_id, id)
);

-- The offload queue: rows still staged in Centaur that haven't been offloaded.
-- Manifest-only artifacts (centaur_ref IS NULL) are skipped permanently.
CREATE INDEX IF NOT EXISTS session_artifacts_offload_queue_idx
  ON session_artifacts (captured_at)
  WHERE offloaded_at IS NULL AND centaur_ref IS NOT NULL;
