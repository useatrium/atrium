ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS centaur_message_attempt int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS centaur_message_id text;
