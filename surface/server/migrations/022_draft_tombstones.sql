ALTER TABLE user_drafts
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
