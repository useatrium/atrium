ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS pending_question jsonb;
