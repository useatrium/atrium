ALTER TABLE cas_blobs
  ADD COLUMN IF NOT EXISTS thumbnail_sha text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'cas_blobs_thumbnail_sha_fkey'
       AND conrelid = 'cas_blobs'::regclass
  ) THEN
    ALTER TABLE cas_blobs
      ADD CONSTRAINT cas_blobs_thumbnail_sha_fkey
        FOREIGN KEY (thumbnail_sha) REFERENCES cas_blobs(sha256) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS cas_blobs_thumbnail_sha_idx
  ON cas_blobs (thumbnail_sha)
  WHERE thumbnail_sha IS NOT NULL;
