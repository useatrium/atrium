ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_s3_key text,
  ADD COLUMN IF NOT EXISTS avatar_content_type text,
  ADD COLUMN IF NOT EXISTS avatar_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS users_avatar_updated_at_idx
  ON users (avatar_updated_at)
  WHERE avatar_s3_key IS NOT NULL;
