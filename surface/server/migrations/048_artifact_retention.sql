-- Retention tombstones for scratch artifact history. Retention clears old
-- superseded version blob references, but leaves an explicit marker so history
-- can explain why bytes are no longer available.

ALTER TABLE artifact_versions
  ADD COLUMN IF NOT EXISTS retention_tombstoned_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_reason text,
  ADD COLUMN IF NOT EXISTS retention_blob_sha text;

-- Replace the original "non-delete versions must have bytes" invariant with
-- "unless retention has explicitly tombstoned the bytes".
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
    FROM pg_constraint
   WHERE conrelid = 'artifact_versions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) = 'CHECK (((kind = ''deleted''::text) OR (blob_sha IS NOT NULL)))'
   LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE artifact_versions DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE artifact_versions
  ADD CONSTRAINT artifact_versions_blob_sha_present_check
  CHECK (
    kind = 'deleted'
    OR blob_sha IS NOT NULL
    OR retention_tombstoned_at IS NOT NULL
  );

ALTER TABLE artifact_versions
  ADD CONSTRAINT artifact_versions_retention_marker_check
  CHECK (
    retention_tombstoned_at IS NULL
    OR (blob_sha IS NULL AND retention_blob_sha IS NOT NULL AND retention_reason IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS artifact_versions_retention_candidates_idx
  ON artifact_versions (created_at, artifact_id, seq)
  WHERE blob_sha IS NOT NULL AND status = 'normal';

-- Future explicit roots. The retention sweep also protects artifact_pointers;
-- this table is the small server-side hook for app-level pins without changing
-- the sweep contract later.
CREATE TABLE IF NOT EXISTS artifact_retention_pins (
  artifact_id uuid NOT NULL,
  seq         int  NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, seq, reason),
  FOREIGN KEY (artifact_id, seq) REFERENCES artifact_versions (artifact_id, seq)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS artifact_retention_pins_artifact_seq_idx
  ON artifact_retention_pins (artifact_id, seq);
