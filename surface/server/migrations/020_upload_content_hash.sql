ALTER TABLE files ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE INDEX IF NOT EXISTS files_uploader_content_hash_idx
  ON files (uploader_id, content_hash)
  WHERE content_hash IS NOT NULL;
