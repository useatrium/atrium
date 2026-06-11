ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS centaur_spawn_attempt int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS centaur_spawn_id text,
  ADD COLUMN IF NOT EXISTS centaur_execute_attempt int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS centaur_execute_id text;
